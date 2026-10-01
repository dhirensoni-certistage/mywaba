import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import { normalizeMessageContent } from "@whiskeysockets/baileys";
import { normalizeJid } from "@/lib/jid-utils";

/**
 * Number-protection helpers shared by the broadcast engine and the message store.
 *
 *  - opt-out handling: a recipient who replies STOP is flagged on the Contact row and
 *    excluded from every future broadcast (and optionally gets a confirmation)
 *  - daily budget: how many broadcast messages this session sent in the last 24h
 *  - quiet hours: whether "now" falls inside the configured do-not-send window
 *  - personalisation: {name} placeholders and {a|b|c} spintax so messages differ
 */

export const DEFAULT_OPT_OUT_KEYWORDS = ["STOP", "UNSUBSCRIBE", "STOP ALL", "CANCEL"];

export interface SafetyConfig {
    dailyBroadcastLimit: number;
    quietHoursStart: number | null;
    quietHoursEnd: number | null;
    optOutEnabled: boolean;
    optOutKeywords: string[];
    optOutReply: string | null;
}

export function readSafetyConfig(botConfig: any): SafetyConfig {
    const keywords = Array.isArray(botConfig?.optOutKeywords) && botConfig.optOutKeywords.length > 0
        ? (botConfig.optOutKeywords as unknown[]).map(k => String(k).trim()).filter(Boolean)
        : DEFAULT_OPT_OUT_KEYWORDS;
    const toHour = (v: unknown) => (v === null || v === undefined || v === "" ? null : Math.max(0, Math.min(23, Number(v))));
    return {
        dailyBroadcastLimit: Math.max(0, Number(botConfig?.dailyBroadcastLimit ?? 200)),
        quietHoursStart: toHour(botConfig?.quietHoursStart),
        quietHoursEnd: toHour(botConfig?.quietHoursEnd),
        optOutEnabled: botConfig?.optOutEnabled ?? true,
        optOutKeywords: keywords,
        optOutReply: botConfig?.optOutReply || null,
    };
}

export async function loadSafetyConfig(sessionId: string): Promise<{ dbSessionId: string | null; safety: SafetyConfig }> {
    const session = await prisma.session.findUnique({
        where: { sessionId },
        select: { id: true, botConfig: true }
    });
    return { dbSessionId: session?.id ?? null, safety: readSafetyConfig(session?.botConfig) };
}

/** Broadcast messages sent by this session in the trailing 24 hours. */
export async function countSentLast24h(sessionId: string): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return prisma.broadcastRecipient.count({
        where: { status: "sent", sentAt: { gte: since }, broadcastLog: { sessionId } }
    });
}

let tzCache: { tz: string; at: number } | null = null;
export async function getSystemTimezone(): Promise<string> {
    if (tzCache && Date.now() - tzCache.at < 60_000) return tzCache.tz;
    let tz = process.env.TZ || "Asia/Kolkata";
    try {
        const cfg = await prisma.systemConfig.findUnique({ where: { id: "default" }, select: { timezone: true } });
        if (cfg?.timezone) tz = cfg.timezone;
    } catch { /* ignore */ }
    tzCache = { tz, at: Date.now() };
    return tz;
}

export function currentHourInTz(tz: string, date = new Date()): number {
    try {
        const h = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(date);
        return Number(h) % 24;
    } catch {
        return date.getHours();
    }
}

/** True when `hour` is inside [start, end) — handles windows that wrap past midnight (e.g. 22 → 8). */
export function isInQuietHours(hour: number, start: number | null, end: number | null): boolean {
    if (start === null || end === null || start === end) return false;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function formatHour(h: number): string {
    const suffix = h >= 12 ? "PM" : "AM";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${String(hh).padStart(2, "0")}:00 ${suffix}`;
}

/** Contact lookup for personalisation / opt-out filtering, one query for the whole list. */
export async function loadContactsForJids(dbSessionId: string, jids: string[]) {
    const normalized = Array.from(new Set(jids.map(j => normalizeJid(j))));
    const rows = await prisma.contact.findMany({
        where: { sessionId: dbSessionId, jid: { in: normalized } },
        select: { jid: true, name: true, notify: true, verifiedName: true, optedOut: true }
    });
    const map = new Map<string, { name: string | null; optedOut: boolean }>();
    for (const r of rows) {
        map.set(r.jid, { name: r.name || r.notify || r.verifiedName || null, optedOut: r.optedOut });
    }
    return map;
}

/**
 * Expand `{name}` / `{name|fallback}` placeholders and `{option a|option b}` spintax.
 * A `{...}` group whose first segment is "name" is a placeholder; any other group with a
 * `|` is spintax; anything else is left untouched.
 */
export function personalize(template: string, vars: { name?: string | null }): string {
    if (!template || !template.includes("{")) return template;
    const out = template.replace(/\{([^{}]*)\}/g, (whole, inner: string) => {
        const parts = inner.split("|");
        const key = parts[0].trim().toLowerCase();
        if (key === "name") {
            const fallback = parts.slice(1).join("|").trim();
            return (vars.name && vars.name.trim()) || fallback;
        }
        if (parts.length > 1) {
            return parts[Math.floor(Math.random() * parts.length)];
        }
        return whole;
    });
    // Tidy spacing left behind by an empty {name}
    return out.replace(/[ \t]{2,}/g, " ").replace(/^ +| +$/gm, "");
}

export function hasPersonalization(template: string): boolean {
    return /\{[^{}]*\}/.test(template || "");
}

function extractText(msg: WAMessage): string {
    const content = normalizeMessageContent(msg.message);
    return content?.conversation || content?.extendedTextMessage?.text || "";
}

/**
 * Called from the message store for every incoming direct message. If the text is an
 * opt-out keyword the contact is flagged and (optionally) gets a confirmation.
 */
export async function handleOptOut(sock: WASocket, dbSessionId: string, msg: WAMessage, botConfig: any): Promise<boolean> {
    try {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || msg.key.fromMe || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return false;

        const safety = readSafetyConfig(botConfig);
        if (!safety.optOutEnabled) return false;

        const text = extractText(msg).trim().toLowerCase().replace(/[.!]+$/, "");
        if (!text || text.length > 40) return false;
        if (!safety.optOutKeywords.some(k => k.toLowerCase() === text)) return false;

        const jid = normalizeJid(msg.key.remoteJidAlt && !msg.key.remoteJidAlt.endsWith("@lid") ? msg.key.remoteJidAlt : remoteJid);
        const existing = await prisma.contact.findUnique({
            where: { sessionId_jid: { sessionId: dbSessionId, jid } },
            select: { optedOut: true }
        });
        if (existing?.optedOut) return true; // already handled, do not reply again

        await prisma.contact.upsert({
            where: { sessionId_jid: { sessionId: dbSessionId, jid } },
            create: { sessionId: dbSessionId, jid, optedOut: true, optedOutAt: new Date(), notify: msg.pushName || undefined },
            update: { optedOut: true, optedOutAt: new Date() }
        });
        logger.info("Safety", `Contact ${jid} opted out of broadcasts`);

        if (safety.optOutReply) {
            try { await sock.sendMessage(remoteJid, { text: safety.optOutReply }); } catch { /* best effort */ }
        }
        return true;
    } catch (e) {
        logger.error("Safety", "Opt-out handling failed", e);
        return false;
    }
}
