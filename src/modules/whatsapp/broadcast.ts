import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { waManager } from "./manager";
import type { AnyMessageContent } from "@whiskeysockets/baileys";
import {
    loadSafetyConfig, countSentLast24h, getSystemTimezone, currentHourInTz, isInQuietHours, formatHour,
    loadContactsForJids, personalize, hasPersonalization, type SafetyConfig, type TemplateVars
} from "./safety";
import { sendInteractiveMessage, sanitizeButtons, type BroadcastButton } from "./interactive";

/**
 * Broadcast engine — anti-ban aware bulk sender.
 *
 * Why this exists: the previous implementation blasted identical messages every
 * ~2s with no number validation, no typing simulation, no batch cooldown and
 * no connection awareness. WhatsApp's spam detection reacts to exactly that
 * pattern by force-unlinking the device (status 401 / "device_removed"), after
 * which every remaining send fails. This module:
 *
 *  - de-duplicates and normalizes recipients
 *  - verifies each number is on WhatsApp before sending (sending to dead numbers
 *    is one of the strongest spam signals)
 *  - enforces a safe minimum delay with wide random jitter
 *  - pauses for a long cooldown after every N messages
 *  - simulates "typing…" presence before each send
 *  - pre-fetches media once instead of re-downloading it per recipient
 *  - watches the live session: waits through short reconnects, aborts cleanly
 *    on logout/stop instead of failing every remaining recipient one by one
 *  - trips a circuit breaker after consecutive failures
 *  - supports cancellation from the dashboard
 */

export const BROADCAST_LIMITS = {
    /** Hard floor for the per-message delay (ms). */
    MIN_DELAY_MS: 3000,
    /** Default per-message delay when the client sends none (ms). */
    DEFAULT_DELAY_MS: 8000,
    /** Max per-message delay accepted from the client (ms). */
    MAX_DELAY_MS: 120000,
    /** Messages sent before taking a longer cooldown. */
    DEFAULT_BATCH_SIZE: 20,
    MIN_BATCH_SIZE: 5,
    MAX_BATCH_SIZE: 100,
    /** Cooldown between batches (ms). */
    DEFAULT_BATCH_PAUSE_MS: 60000,
    MIN_BATCH_PAUSE_MS: 15000,
    MAX_BATCH_PAUSE_MS: 600000,
    /** Max recipients accepted in a single broadcast. */
    MAX_RECIPIENTS: 500,
    /** Abort after this many consecutive send failures. */
    MAX_CONSECUTIVE_FAILURES: 5,
    /** How long to wait for a session to come back before aborting (ms). */
    RECONNECT_WAIT_MS: 120000,
    /** Numbers checked per onWhatsApp() call. */
    CHECK_CHUNK_SIZE: 10,
};

export type BroadcastStatus = "running" | "completed" | "cancelled" | "failed";

/** A recipient is a bare number/JID or an object carrying per-recipient template variables. */
export type RecipientInput = string | { number?: string; jid?: string; phone?: string; name?: string | null; vars?: TemplateVars | null; [extra: string]: unknown };

export interface PreparedRecipient {
    jid: string;
    vars: TemplateVars;
}

export interface BroadcastOptions {
    sessionId: string;
    recipients: RecipientInput[];
    message: string;
    mediaUrl?: string | null;
    mediaType?: string | null;
    /** Per-message delay in ms (clamped to limits). */
    delay?: number;
    /** Messages per batch before a long pause (clamped to limits). */
    batchSize?: number;
    /** Pause between batches in ms (clamped to limits). */
    batchPauseMs?: number;
    /** Send "typing…" presence before each message. Default true. */
    simulateTyping?: boolean;
    /** Verify numbers with onWhatsApp() before sending. Default true. */
    validateNumbers?: boolean;
    /** Send in random order instead of list order. Default true. */
    shuffle?: boolean;
    /**
     * Spread the whole run evenly over this many hours. Overrides `delay`, `batchSize` and
     * `batchPauseMs`: the per-message gap becomes hours*3600/recipients (never below the minimum).
     */
    spreadHours?: number;
    /** Up to 3 interactive buttons (BETA — see interactive.ts). Validated with sanitizeButtons(). */
    buttons?: Array<{ type?: string; text: string; url?: string; phone?: string }> | BroadcastButton[];
    /** Optional footer line under the button message. */
    footer?: string;
}

export interface BroadcastHealth {
    sentLast24h: number;
    dailyLimit: number;
    remaining: number;
    quietHours: { start: number | null; end: number | null; active: boolean; label: string | null };
    optedOutCount: number;
    timezone: string;
    sessionStatus: string;
    lastDisconnectReason: string | null;
}

/** Snapshot of the number's broadcast budget + protections — shown on the Broadcast page. */
export async function getBroadcastHealth(sessionId: string): Promise<BroadcastHealth> {
    const [{ dbSessionId, safety }, sentLast24h, timezone] = await Promise.all([
        loadSafetyConfig(sessionId),
        countSentLast24h(sessionId),
        getSystemTimezone()
    ]);
    const optedOutCount = dbSessionId
        ? await prisma.contact.count({ where: { sessionId: dbSessionId, optedOut: true } })
        : 0;
    const hour = currentHourInTz(timezone);
    const active = isInQuietHours(hour, safety.quietHoursStart, safety.quietHoursEnd);
    const label = safety.quietHoursStart !== null && safety.quietHoursEnd !== null
        ? `${formatHour(safety.quietHoursStart)} – ${formatHour(safety.quietHoursEnd)}`
        : null;
    const instance = waManager.getInstance(sessionId);
    return {
        sentLast24h,
        dailyLimit: safety.dailyBroadcastLimit,
        remaining: safety.dailyBroadcastLimit > 0 ? Math.max(0, safety.dailyBroadcastLimit - sentLast24h) : Number.POSITIVE_INFINITY,
        quietHours: { start: safety.quietHoursStart, end: safety.quietHoursEnd, active, label },
        optedOutCount,
        timezone,
        sessionStatus: instance?.status || "STOPPED",
        lastDisconnectReason: instance?.lastDisconnectReason || null
    };
}

export interface BroadcastProgressPayload {
    broadcastId: string;
    sessionId?: string;
    status: BroadcastStatus;
    total: number;
    sent: number;
    failed: number;
    skipped?: number;
    current?: string | null;
    progress: number;
    /** Human-readable note about what the engine is doing (cooldown, waiting for reconnect…). */
    note?: string | null;
    error?: string | null;
    errors?: { jid: string; error: string }[];
    startedAt?: string;
    completedAt?: string;
}

const cancelledBroadcasts = new Set<string>();
const activeBroadcasts = new Map<string, { sessionId: string; startedAt: number }>();

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const randomBetween = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));

/** Normalize a user-entered recipient into a JID. */
export function normalizeRecipient(raw: string): string | null {
    const value = raw.trim();
    if (!value) return null;
    if (value.includes("@")) {
        // Already a JID (user, group, lid). Strip device suffix if any.
        return value.replace(/:\d+(?=@)/, "");
    }
    const digits = value.replace(/[^0-9]/g, "");
    if (digits.length < 7 || digits.length > 15) return null;
    return `${digits}@s.whatsapp.net`;
}

/** De-duplicate + normalize. Returns valid recipients (with their variables) and the raw inputs that were rejected. */
export function prepareRecipients(raw: RecipientInput[]): { recipients: PreparedRecipient[]; jids: string[]; invalid: string[] } {
    const seen = new Set<string>();
    const recipients: PreparedRecipient[] = [];
    const invalid: string[] = [];
    for (const r of raw) {
        let numberLike: string;
        let vars: TemplateVars = {};
        if (typeof r === "string") {
            numberLike = r;
        } else if (r && typeof r === "object") {
            numberLike = String(r.jid ?? r.number ?? r.phone ?? "");
            const { jid: _j, number: _n, phone: _p, vars: nested, name, ...rest } = r;
            vars = { ...(nested || {}), ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)])) };
            if (name !== undefined && name !== null) vars.name = String(name);
        } else {
            invalid.push(String(r)); continue;
        }
        const jid = normalizeRecipient(numberLike);
        if (!jid) { invalid.push(numberLike || String(r)); continue; }
        if (seen.has(jid)) continue;
        seen.add(jid);
        recipients.push({ jid, vars });
    }
    return { recipients, jids: recipients.map(r => r.jid), invalid };
}

/** Per-message delay for a run that should finish in `spreadHours`. */
export function delayForSpread(recipientCount: number, spreadHours: number): number {
    const totalMs = Math.max(0, spreadHours) * 3600 * 1000;
    const perMessage = recipientCount > 1 ? totalMs / (recipientCount - 1) : BROADCAST_LIMITS.DEFAULT_DELAY_MS;
    // the engine adds 0..60% jitter on top, so target the average gap (×1.3) at the requested spread
    return clamp(Math.round(perMessage / 1.3), BROADCAST_LIMITS.MIN_DELAY_MS, BROADCAST_LIMITS.MAX_DELAY_MS);
}

/** Translate low-level Baileys / runtime errors into something a user can act on. */
export function describeSendError(e: any): string {
    const msg: string = e?.message || e?.output?.payload?.message || String(e || "Unknown error");
    const code = e?.output?.statusCode;
    if (/Cannot read properties of null|socket is null|not connected/i.test(msg)) {
        return "Session not connected";
    }
    if (/Connection Closed|Connection was lost|Connection Terminated|WebSocket is not open/i.test(msg)) {
        return "WhatsApp connection closed while sending";
    }
    if (code === 401 || /logged out|device_removed/i.test(msg)) {
        return "Session was logged out by WhatsApp";
    }
    if (/Timed Out|timeout/i.test(msg)) {
        return "Timed out waiting for WhatsApp";
    }
    if (/rate-overlimit|too many|429/i.test(msg)) {
        return "WhatsApp rate limit hit";
    }
    if (/not on whatsapp|no such user|item-not-found|404/i.test(msg)) {
        return "Number is not registered on WhatsApp";
    }
    return msg.length > 300 ? msg.slice(0, 300) : msg;
}

export function cancelBroadcast(broadcastId: string): boolean {
    if (!activeBroadcasts.has(broadcastId)) return false;
    cancelledBroadcasts.add(broadcastId);
    return true;
}

export function isBroadcastActive(broadcastId: string): boolean {
    return activeBroadcasts.has(broadcastId);
}

/**
 * On boot, any broadcast still marked "running" was interrupted by a restart.
 * Mark it so the dashboard does not show it as in-progress forever.
 */
export async function recoverStaleBroadcasts() {
    try {
        const stale = await prisma.broadcastLog.findMany({
            where: { status: "running" },
            select: { id: true }
        });
        if (stale.length === 0) return;
        const ids = stale.map(s => s.id);
        await prisma.$transaction([
            prisma.broadcastRecipient.updateMany({
                where: { broadcastLogId: { in: ids }, status: "pending" },
                data: { status: "failed", error: "Server restarted while broadcast was running" }
            }),
            prisma.broadcastLog.updateMany({
                where: { id: { in: ids } },
                data: { status: "failed", error: "Server restarted while broadcast was running", completedAt: new Date() }
            })
        ]);
        logger.warn("Broadcast", `Marked ${ids.length} interrupted broadcast(s) as failed after restart.`);
    } catch (e) {
        logger.error("Broadcast", "Failed to recover stale broadcasts", e);
    }
}

/** Fetch media once so Baileys does not download it again for every recipient. */
async function buildMessageContent(opts: BroadcastOptions): Promise<AnyMessageContent> {
    const caption = opts.message || "";
    if (!opts.mediaUrl) {
        return { text: caption };
    }

    let url = opts.mediaUrl;
    if (url.startsWith("/")) {
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3030}`;
        url = `${baseUrl.replace(/\/$/, "")}${url}`;
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch media (${res.status} ${res.statusText})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
    const fileName = decodeURIComponent(url.split("/").pop() || "file").split("?")[0] || "file";
    const type = (opts.mediaType || "image").toLowerCase();

    if (type === "video") {
        return { video: buffer, caption, mimetype: contentType || "video/mp4" };
    }
    if (type === "document") {
        return { document: buffer, caption, mimetype: contentType || "application/octet-stream", fileName };
    }
    if (type === "audio") {
        return { audio: buffer, mimetype: contentType || "audio/mp4" };
    }
    return { image: buffer, caption };
}

/**
 * Wait for the session to be CONNECTED. Returns the live socket, or null if the
 * session is gone / logged out / stopped, or the wait budget ran out.
 */
async function waitForConnection(sessionId: string, broadcastId: string, emit: (p: Partial<BroadcastProgressPayload>) => void, budgetMs: number) {
    const started = Date.now();
    let noted = false;
    while (Date.now() - started < budgetMs) {
        if (cancelledBroadcasts.has(broadcastId)) return { socket: null, reason: "cancelled" as const };

        const instance = waManager.getInstance(sessionId);
        if (!instance) {
            return { socket: null, reason: "Session is not running (logged out or stopped)" };
        }
        if (instance.status === "LOGGED_OUT") {
            return { socket: null, reason: "Session was logged out by WhatsApp" };
        }
        if (instance.status === "STOPPED" || instance.isStopped) {
            return { socket: null, reason: "Session was stopped" };
        }
        if (instance.status === "CONNECTED" && instance.socket) {
            return { socket: instance.socket, reason: null };
        }
        if (!noted) {
            noted = true;
            emit({ note: "Session disconnected — waiting for it to reconnect…" });
            logger.warn("Broadcast", `${broadcastId}: session ${sessionId} is ${instance.status}; waiting for reconnect`);
        }
        await sleep(2000);
    }
    return { socket: null, reason: "Session did not reconnect in time" };
}

export async function startBroadcast(opts: BroadcastOptions): Promise<{ broadcastId: string; total: number; invalid: string[]; delayMs: number }> {
    const { sessionId } = opts;
    const { recipients, jids, invalid } = prepareRecipients(opts.recipients);

    if (jids.length === 0) throw new Error("No valid recipients");
    if (jids.length > BROADCAST_LIMITS.MAX_RECIPIENTS) {
        throw new Error(`Too many recipients (${jids.length}). Maximum per broadcast is ${BROADCAST_LIMITS.MAX_RECIPIENTS}. Split it into smaller batches spread over the day.`);
    }

    const instance = waManager.getInstance(sessionId);
    if (!instance?.socket || instance.status !== "CONNECTED") {
        throw new Error("Session not connected");
    }

    const spreadHours = Number(opts.spreadHours) > 0 ? Math.min(72, Number(opts.spreadHours)) : 0;
    let delayMs = clamp(Number(opts.delay) || BROADCAST_LIMITS.DEFAULT_DELAY_MS, BROADCAST_LIMITS.MIN_DELAY_MS, BROADCAST_LIMITS.MAX_DELAY_MS);
    let batchSize = clamp(Number(opts.batchSize) || BROADCAST_LIMITS.DEFAULT_BATCH_SIZE, BROADCAST_LIMITS.MIN_BATCH_SIZE, BROADCAST_LIMITS.MAX_BATCH_SIZE);
    let batchPauseMs = clamp(Number(opts.batchPauseMs) || BROADCAST_LIMITS.DEFAULT_BATCH_PAUSE_MS, BROADCAST_LIMITS.MIN_BATCH_PAUSE_MS, BROADCAST_LIMITS.MAX_BATCH_PAUSE_MS);
    if (spreadHours > 0) {
        // Even pacing across the window replaces the batch rhythm.
        delayMs = delayForSpread(jids.length, spreadHours);
        batchSize = BROADCAST_LIMITS.MAX_BATCH_SIZE;
        batchPauseMs = BROADCAST_LIMITS.MIN_BATCH_PAUSE_MS;
    }
    const buttons = sanitizeButtons(opts.buttons);
    const footer = opts.footer?.trim().slice(0, 60) || undefined;
    const simulateTyping = opts.simulateTyping !== false;
    const validateNumbers = opts.validateNumbers !== false;
    const shuffle = opts.shuffle !== false;

    // Number protection: daily budget check before anything is queued.
    const { dbSessionId, safety } = await loadSafetyConfig(sessionId);
    if (!dbSessionId) throw new Error("Session not found");
    const sentLast24h = await countSentLast24h(sessionId);
    if (safety.dailyBroadcastLimit > 0) {
        const remaining = safety.dailyBroadcastLimit - sentLast24h;
        if (remaining <= 0) {
            throw new Error(`Daily limit reached: ${sentLast24h} broadcast messages were already sent in the last 24 hours (limit ${safety.dailyBroadcastLimit}). Wait, or raise the limit in Bot Settings → Broadcast Safety.`);
        }
        if (jids.length > remaining) {
            throw new Error(`Only ${remaining} of your daily limit of ${safety.dailyBroadcastLimit} remain (${sentLast24h} sent in the last 24 hours), but this list has ${jids.length} recipients. Send to at most ${remaining} now, or raise the limit in Bot Settings → Broadcast Safety.`);
        }
    }

    // Build content first so a bad media URL fails fast instead of per recipient.
    const messageContent = await buildMessageContent(opts);

    const log = await prisma.broadcastLog.create({
        data: {
            sessionId,
            message: opts.message || (opts.mediaUrl ? `[Media: ${opts.mediaType || "file"}]` : ""),
            total: jids.length,
            delay: delayMs,
            status: "running",
            recipients: { create: jids.map(jid => ({ jid, status: "pending" })) }
        }
    });

    const broadcastId = log.id;
    activeBroadcasts.set(broadcastId, { sessionId, startedAt: Date.now() });

    const io = (global as any).io;
    const emit = (partial: Partial<BroadcastProgressPayload> & { status?: BroadcastStatus }) => {
        if (!io) return;
        io.to(sessionId).emit("broadcast.progress", { broadcastId, sessionId, total: jids.length, ...partial });
    };

    emit({ status: "running", sent: 0, failed: 0, progress: 0, current: null, startedAt: log.startedAt.toISOString(), note: validateNumbers ? "Validating numbers…" : null });

    // Fire and forget — the HTTP request returns immediately.
    runBroadcast({ broadcastId, sessionId, dbSessionId, jids, recipients, messageContent, template: opts.message || "", delayMs, batchSize, batchPauseMs, simulateTyping, validateNumbers, shuffle, safety, sentBefore: sentLast24h, buttons, footer, emit })
        .catch(e => logger.error("Broadcast", `${broadcastId} crashed`, e))
        .finally(() => {
            activeBroadcasts.delete(broadcastId);
            cancelledBroadcasts.delete(broadcastId);
        });

    return { broadcastId, total: jids.length, invalid, delayMs };
}

interface RunArgs {
    broadcastId: string;
    sessionId: string;
    dbSessionId: string;
    jids: string[];
    recipients: PreparedRecipient[];
    messageContent: AnyMessageContent;
    /** Raw text/caption with {name} / {a|b} placeholders. */
    template: string;
    delayMs: number;
    batchSize: number;
    batchPauseMs: number;
    simulateTyping: boolean;
    validateNumbers: boolean;
    shuffle: boolean;
    safety: SafetyConfig;
    /** Broadcast messages already sent in the trailing 24h when this run started. */
    sentBefore: number;
    buttons: BroadcastButton[];
    footer?: string;
    emit: (p: Partial<BroadcastProgressPayload> & { status?: BroadcastStatus }) => void;
}

/** Personalised copy of the base content for one recipient (text or caption). */
function contentFor(base: AnyMessageContent, template: string, vars: TemplateVars): AnyMessageContent {
    if (!hasPersonalization(template)) return base;
    const text = personalize(template, vars);
    const anyBase = base as any;
    if ("text" in anyBase) return { ...anyBase, text } as AnyMessageContent;
    if ("caption" in anyBase) return { ...anyBase, caption: text } as AnyMessageContent;
    return base;
}

async function runBroadcast(args: RunArgs) {
    const { broadcastId, sessionId, dbSessionId, jids, recipients, messageContent, template, delayMs, batchSize, batchPauseMs, simulateTyping, validateNumbers, shuffle, safety, sentBefore, buttons, footer, emit } = args;
    const timezone = await getSystemTimezone();
    const varsByJid = new Map(recipients.map(r => [r.jid, r.vars]));
    let interactiveBroken = false;

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let consecutiveFailures = 0;
    const errors: { jid: string; error: string }[] = [];
    const total = jids.length;

    const markRecipient = (jid: string, data: { status: string; error?: string | null; sentAt?: Date | null }) =>
        prisma.broadcastRecipient.updateMany({ where: { broadcastLogId: broadcastId, jid }, data }).catch(() => {});

    const persistCounters = () =>
        prisma.broadcastLog.update({ where: { id: broadcastId }, data: { sent, failed } }).catch(() => {});

    const finish = async (status: BroadcastStatus, error?: string | null) => {
        const now = new Date();
        const pendingReason = error || (status === "cancelled" ? "Cancelled by user" : "Not sent");
        try {
            const pending = await prisma.broadcastRecipient.updateMany({
                where: { broadcastLogId: broadcastId, status: "pending" },
                data: { status: "failed", error: pendingReason }
            });
            failed += pending.count;
        } catch { /* ignore */ }

        await prisma.broadcastLog.update({
            where: { id: broadcastId },
            data: { status, sent, failed, error: error || null, completedAt: now }
        }).catch(() => {});

        emit({ status, sent, failed, skipped, errors, error: error || null, progress: 100, current: null, note: null, completedAt: now.toISOString() });
        logger[status === "completed" ? "success" : "warn"]("Broadcast",
            `${broadcastId} ${status}: ${sent} sent, ${failed} failed (${skipped} skipped as invalid) of ${total}${error ? ` — ${error}` : ""}`
        );
    };

    const progress = () => Math.round(((sent + failed) / total) * 100);

    try {
        // ---- Phase 1: validate numbers (groups and LIDs are not checked) ----
        // rowJid = the normalized input we stored in BroadcastRecipient; targetJid = where we actually send.
        const toSend: { rowJid: string; targetJid: string }[] = [];
        if (validateNumbers) {
            const phoneJids = jids.filter(j => j.endsWith("@s.whatsapp.net"));
            const others = jids.filter(j => !j.endsWith("@s.whatsapp.net"));
            const okSet = new Set<string>(others);
            const resolvedJid = new Map<string, string>();

            for (let i = 0; i < phoneJids.length; i += BROADCAST_LIMITS.CHECK_CHUNK_SIZE) {
                if (cancelledBroadcasts.has(broadcastId)) { await finish("cancelled"); return; }

                const chunk = phoneJids.slice(i, i + BROADCAST_LIMITS.CHECK_CHUNK_SIZE);
                const conn = await waitForConnection(sessionId, broadcastId, emit, BROADCAST_LIMITS.RECONNECT_WAIT_MS);
                if (!conn.socket) {
                    if (conn.reason === "cancelled") { await finish("cancelled"); return; }
                    await finish("failed", conn.reason);
                    return;
                }

                try {
                    const numbers = chunk.map(j => j.split("@")[0]);
                    const results = (await conn.socket.onWhatsApp(...numbers)) || [];
                    const existing = new Map<string, string>();
                    for (const r of results) {
                        if (r?.exists && r.jid) {
                            existing.set(r.jid.split("@")[0].replace(/:\d+$/, ""), r.jid);
                        }
                    }
                    for (const jid of chunk) {
                        const number = jid.split("@")[0];
                        const match = existing.get(number);
                        if (match) {
                            okSet.add(jid);
                            if (match !== jid) resolvedJid.set(jid, match);
                        } else {
                            skipped++;
                            failed++;
                            errors.push({ jid, error: "Number is not registered on WhatsApp — skipped" });
                            await markRecipient(jid, { status: "failed", error: "Number is not registered on WhatsApp — skipped" });
                        }
                    }
                } catch (e) {
                    // If the lookup itself fails, don't punish the recipients — send anyway.
                    logger.warn("Broadcast", `${broadcastId}: onWhatsApp lookup failed, sending without validation for this chunk`, describeSendError(e));
                    chunk.forEach(j => okSet.add(j));
                }

                emit({ status: "running", sent, failed, skipped, progress: progress(), current: null, note: `Validating numbers… ${Math.min(i + chunk.length, phoneJids.length)}/${phoneJids.length}` });
                await sleep(randomBetween(400, 900));
            }

            for (const jid of jids) {
                if (okSet.has(jid)) toSend.push({ rowJid: jid, targetJid: resolvedJid.get(jid) || jid });
            }
            await persistCounters();
        } else {
            toSend.push(...jids.map(jid => ({ rowJid: jid, targetJid: jid })));
        }

        // ---- Phase 1b: opt-outs + personalisation data ----
        const contacts = await loadContactsForJids(dbSessionId, toSend.map(t => t.targetJid)).catch(() => new Map());
        if (safety.optOutEnabled) {
            for (let i = toSend.length - 1; i >= 0; i--) {
                const { rowJid, targetJid } = toSend[i];
                const c = contacts.get(targetJid) || contacts.get(rowJid);
                if (c?.optedOut) {
                    toSend.splice(i, 1);
                    skipped++;
                    failed++;
                    errors.push({ jid: rowJid, error: "Recipient opted out (replied STOP) — skipped" });
                    await markRecipient(rowJid, { status: "failed", error: "Recipient opted out (replied STOP) — skipped" });
                }
            }
            await persistCounters();
        }

        if (shuffle) {
            for (let i = toSend.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [toSend[i], toSend[j]] = [toSend[j], toSend[i]];
            }
        }

        // ---- Phase 2: send ----
        let sentInBatch = 0;
        for (let i = 0; i < toSend.length; i++) {
            const { rowJid, targetJid } = toSend[i];

            if (cancelledBroadcasts.has(broadcastId)) { await finish("cancelled"); return; }

            // Daily budget (another broadcast or API sends may have consumed it meanwhile)
            if (safety.dailyBroadcastLimit > 0 && sentBefore + sent >= safety.dailyBroadcastLimit) {
                await finish("failed", `Daily send limit of ${safety.dailyBroadcastLimit} reached. ${toSend.length - i} recipient(s) were not sent — continue tomorrow or raise the limit in Bot Settings → Broadcast Safety.`);
                return;
            }

            // Quiet hours: hold until the window ends
            while (isInQuietHours(currentHourInTz(timezone), safety.quietHoursStart, safety.quietHoursEnd)) {
                if (cancelledBroadcasts.has(broadcastId)) { await finish("cancelled"); return; }
                emit({ status: "running", sent, failed, skipped, progress: progress(), current: null, note: `Quiet hours (${formatHour(safety.quietHoursStart!)} – ${formatHour(safety.quietHoursEnd!)} ${timezone}) — sending resumes at ${formatHour(safety.quietHoursEnd!)}` });
                await sleep(30000);
            }

            // Batch cooldown
            if (sentInBatch >= batchSize) {
                const pause = randomBetween(batchPauseMs, Math.round(batchPauseMs * 1.5));
                emit({ status: "running", sent, failed, skipped, progress: progress(), current: null, note: `Cooling down for ${Math.round(pause / 1000)}s after ${sentInBatch} messages…` });
                logger.info("Broadcast", `${broadcastId}: batch of ${sentInBatch} done, cooling down ${Math.round(pause / 1000)}s`);
                const until = Date.now() + pause;
                while (Date.now() < until) {
                    if (cancelledBroadcasts.has(broadcastId)) { await finish("cancelled"); return; }
                    await sleep(Math.min(1000, until - Date.now()));
                }
                sentInBatch = 0;
            }

            const conn = await waitForConnection(sessionId, broadcastId, emit, BROADCAST_LIMITS.RECONNECT_WAIT_MS);
            if (!conn.socket) {
                if (conn.reason === "cancelled") { await finish("cancelled"); return; }
                await finish("failed", conn.reason);
                return;
            }
            const socket = conn.socket;

            emit({ status: "running", sent, failed, skipped, progress: progress(), current: targetJid, note: null });

            try {
                if (simulateTyping) {
                    try {
                        await socket.presenceSubscribe(targetJid);
                        await socket.sendPresenceUpdate("composing", targetJid);
                        const textLen: number = template.length || (messageContent as any).text?.length || (messageContent as any).caption?.length || 40;
                        await sleep(clamp(Math.round(textLen * 25), 1200, 4500) + randomBetween(0, 800));
                        await socket.sendPresenceUpdate("paused", targetJid);
                    } catch { /* presence is best effort */ }
                }

                const contact = contacts.get(targetJid) || contacts.get(rowJid);
                const vars: TemplateVars = { name: contact?.name ?? null, ...(varsByJid.get(rowJid) || {}) };
                const personalised = contentFor(messageContent, template, vars);
                if (buttons.length > 0 && !interactiveBroken) {
                    try {
                        await sendInteractiveMessage(socket, sessionId, targetJid, personalised, buttons, footer);
                    } catch (e: any) {
                        // Interactive messages are best-effort; once they fail, fall back to plain sends for the rest of the run.
                        interactiveBroken = true;
                        logger.warn("Broadcast", `${broadcastId}: interactive buttons failed (${describeSendError(e)}), falling back to plain messages`);
                        emit({ status: "running", sent, failed, skipped, progress: progress(), current: targetJid, note: "Buttons not accepted by WhatsApp — continuing without buttons" });
                        await socket.sendMessage(targetJid, personalised);
                    }
                } else {
                    await socket.sendMessage(targetJid, personalised);
                }
                sent++;
                sentInBatch++;
                consecutiveFailures = 0;
                await markRecipient(rowJid, { status: "sent", sentAt: new Date(), error: null });
            } catch (e: any) {
                failed++;
                consecutiveFailures++;
                const reason = describeSendError(e);
                errors.push({ jid: targetJid, error: reason });
                logger.error("Broadcast", `${broadcastId}: failed to send to ${targetJid}: ${reason}`);
                await markRecipient(rowJid, { status: "failed", error: reason });

                if (consecutiveFailures >= BROADCAST_LIMITS.MAX_CONSECUTIVE_FAILURES) {
                    await persistCounters();
                    await finish("failed", `Aborted after ${consecutiveFailures} consecutive failures (last error: ${reason}). Check the session connection before retrying.`);
                    return;
                }
            }

            await persistCounters();
            emit({ status: "running", sent, failed, skipped, progress: progress(), current: targetJid, note: null });

            // Delay between sends: base delay with +0..60% random jitter
            if (i < toSend.length - 1) {
                const wait = randomBetween(delayMs, Math.round(delayMs * 1.6));
                const until = Date.now() + wait;
                while (Date.now() < until) {
                    if (cancelledBroadcasts.has(broadcastId)) { await finish("cancelled"); return; }
                    await sleep(Math.min(1000, until - Date.now()));
                }
            }
        }

        await finish("completed");
    } catch (e: any) {
        logger.error("Broadcast", `${broadcastId}: unexpected error`, e);
        await finish("failed", describeSendError(e));
    }
}
