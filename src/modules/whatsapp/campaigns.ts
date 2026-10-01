/**
 * Campaigns = broadcasts that start later (once or on a schedule) instead of when someone presses
 * Start with the browser open.
 *
 * A Campaign row stores everything the Broadcast page would have sent (payload), plus either a
 * contact list (resolved at run time, so a list edited after scheduling is honoured) or an inline
 * recipient snapshot. The scheduler tick (cron.ts, every minute) claims due campaigns atomically,
 * starts the broadcast(s) through the same engine as the Broadcast page — daily limit, warm-up,
 * quiet hours, pre-validation and multi-number rotation all apply — and either schedules the next
 * occurrence (cron) or marks the campaign done.
 */
import cronParser from "cron-parser";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { sendAlert } from "@/lib/alerts";
import { canAccessSession } from "@/lib/api-auth";
import { waManager } from "./manager";
import { startBroadcast, type RecipientInput, type BroadcastOptions } from "./broadcast";
import { getSystemTimezone } from "./safety";

export type CampaignStatus = "SCHEDULED" | "RUNNING" | "PAUSED" | "DONE" | "FAILED" | "CANCELLED";

/** Everything in a broadcast request except the recipients and the primary session. */
export type BroadcastPayload = Omit<BroadcastOptions, "sessionId" | "recipients" | "retryOf"> & { sessionIds?: string[] };

export interface LaunchResult {
    started: { sessionId: string; broadcastId: string; total: number; delayMs: number }[];
    total: number;
    invalid: string[];
    rejectedSessions: { sessionId: string; reason: string }[];
    failures: { sessionId: string; error: string }[];
}

/** How long a due campaign waits for its number to come back online before it is marked failed. */
export const CAMPAIGN_OFFLINE_GRACE_MIN = 30;

/**
 * Start one broadcast per target number, splitting the recipients round-robin across the primary
 * session and every extra session the user may use that is currently connected.
 * Shared by POST /broadcast (immediate) and the campaign scheduler.
 */
export async function launchBroadcasts(args: {
    userId: string;
    userRole: string;
    sessionId: string;
    recipients: RecipientInput[];
    payload: BroadcastPayload;
}): Promise<LaunchResult> {
    const { userId, userRole, sessionId, recipients, payload } = args;
    const { sessionIds, ...common } = payload;

    const targetSessions: string[] = [sessionId];
    const rejectedSessions: LaunchResult["rejectedSessions"] = [];
    for (const extra of Array.from(new Set(sessionIds || []))) {
        if (extra === sessionId) continue;
        const ok = await canAccessSession(userId, userRole, extra);
        if (!ok) { rejectedSessions.push({ sessionId: extra, reason: "no access" }); continue; }
        const inst = waManager.getInstance(extra);
        if (!inst?.socket || inst.status !== "CONNECTED") { rejectedSessions.push({ sessionId: extra, reason: "not connected" }); continue; }
        targetSessions.push(extra);
    }

    const buckets: RecipientInput[][] = targetSessions.map(() => []);
    recipients.forEach((r, i) => { buckets[i % targetSessions.length].push(r); });

    const started: LaunchResult["started"] = [];
    const invalid: string[] = [];
    const failures: LaunchResult["failures"] = [];
    for (let i = 0; i < targetSessions.length; i++) {
        if (buckets[i].length === 0) continue;
        try {
            const result = await startBroadcast({ sessionId: targetSessions[i], recipients: buckets[i], ...common });
            started.push({ sessionId: targetSessions[i], broadcastId: result.broadcastId, total: result.total, delayMs: result.delayMs });
            invalid.push(...result.invalid);
        } catch (e: any) {
            // The primary session failing is a hard error; an extra session failing just means its share is not sent.
            if (i === 0) throw e;
            failures.push({ sessionId: targetSessions[i], error: e?.message || "Failed to start" });
        }
    }
    return { started, total: started.reduce((n, b) => n + b.total, 0), invalid: Array.from(new Set(invalid)), rejectedSessions, failures };
}

// ---------------------------------------------------------------------------------------------
// Scheduling helpers
// ---------------------------------------------------------------------------------------------

export type Repeat = "none" | "daily" | "weekly" | "monthly";

/** Hour/minute/day-of-week/day-of-month of `date` in `timezone`. */
function partsIn(date: Date, timezone: string) {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "numeric", hour12: false, weekday: "short", day: "numeric" });
    const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    return { hour: Number(parts.hour) % 24, minute: Number(parts.minute), dow: dow < 0 ? 0 : dow, dom: Number(parts.day) };
}

/** Build the cron expression for a repeat preset anchored at the first run time. */
export function cronForRepeat(repeat: Repeat, firstRun: Date, timezone: string): string | null {
    if (repeat === "none") return null;
    const { hour, minute, dow, dom } = partsIn(firstRun, timezone);
    if (repeat === "daily") return `${minute} ${hour} * * *`;
    if (repeat === "weekly") return `${minute} ${hour} * * ${dow}`;
    return `${minute} ${hour} ${Math.min(dom, 28)} * *`;
}

export function describeCron(cron: string | null | undefined, timezone?: string | null): string {
    if (!cron) return "once";
    const [m, h, dom, , dow] = cron.split(" ");
    const hh = String(h).padStart(2, "0"), mm = String(m).padStart(2, "0");
    const tz = timezone ? ` (${timezone})` : "";
    if (dom === "*" && dow === "*") return `daily at ${hh}:${mm}${tz}`;
    if (dom === "*" && dow !== "*") return `weekly on ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Number(dow)] ?? dow} at ${hh}:${mm}${tz}`;
    if (dom !== "*" && dow === "*") return `monthly on day ${dom} at ${hh}:${mm}${tz}`;
    return `${cron}${tz}`;
}

export function nextRunAfter(cron: string, timezone: string, after: Date): Date | null {
    try {
        return cronParser.parse(cron, { tz: timezone, currentDate: after }).next().toDate();
    } catch {
        return null;
    }
}

export function validateCron(cron: string): boolean {
    try { cronParser.parse(cron); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

async function resolveRecipients(c: { listId: string | null; recipients: unknown }): Promise<RecipientInput[]> {
    if (c.listId) {
        const members = await prisma.contactListMember.findMany({ where: { listId: c.listId }, select: { jid: true, name: true, vars: true } });
        return members.map(m => ({ jid: m.jid, name: m.name, vars: (m.vars as Record<string, string | null> | null) || undefined }));
    }
    return Array.isArray(c.recipients) ? (c.recipients as RecipientInput[]) : [];
}

let tickRunning = false;

/** Called every minute by the scheduler. Starts every campaign whose time has come. */
export async function runDueCampaigns() {
    if (tickRunning) return;
    tickRunning = true;
    try {
        const now = new Date();
        const due = await prisma.campaign.findMany({
            where: { status: "SCHEDULED", nextRunAt: { lte: now } },
            include: { session: { select: { sessionId: true, name: true } }, user: { select: { role: true } } },
            orderBy: { nextRunAt: "asc" },
            take: 20
        });
        for (const c of due) {
            const claimed = await prisma.campaign.updateMany({ where: { id: c.id, status: "SCHEDULED" }, data: { status: "RUNNING" } });
            if (claimed.count !== 1) continue;
            await runCampaign(c, now).catch(e => logger.error("Campaign", `${c.id} runner crashed`, e));
        }
    } catch (e) {
        logger.error("Campaign", "tick failed", e);
    } finally {
        tickRunning = false;
    }
}

type DueCampaign = Awaited<ReturnType<typeof prisma.campaign.findMany<{ include: { session: { select: { sessionId: true; name: true } }; user: { select: { role: true } } } }>>>[number];

async function runCampaign(c: DueCampaign, now: Date) {
    const timezone = c.timezone || await getSystemTimezone();
    const nextOccurrence = () => (c.cronExpression ? nextRunAfter(c.cronExpression, timezone, now) : null);

    // The number is offline: wait a little (phone rebooting, network blip) before giving up on this occurrence.
    const inst = waManager.getInstance(c.session.sessionId);
    if (!inst?.socket || inst.status !== "CONNECTED") {
        const waitedMin = c.nextRunAt ? (now.getTime() - c.nextRunAt.getTime()) / 60000 : 0;
        if (waitedMin < CAMPAIGN_OFFLINE_GRACE_MIN) {
            await prisma.campaign.update({ where: { id: c.id }, data: { status: "SCHEDULED", lastError: `Waiting: ${c.session.name} is not connected (retrying for up to ${CAMPAIGN_OFFLINE_GRACE_MIN} min)` } });
            return;
        }
        await finishWithError(c, now, `Number "${c.session.name}" was not connected for ${CAMPAIGN_OFFLINE_GRACE_MIN} minutes after the scheduled time`, nextOccurrence());
        return;
    }

    try {
        const recipients = await resolveRecipients(c);
        if (recipients.length === 0) throw new Error(c.listId ? "The contact list is empty" : "No recipients");
        const payload = (c.payload || {}) as BroadcastPayload;
        const result = await launchBroadcasts({ userId: c.userId, userRole: c.user.role, sessionId: c.session.sessionId, recipients, payload });
        const next = nextOccurrence();
        await prisma.campaign.update({
            where: { id: c.id },
            data: {
                status: next ? "SCHEDULED" : "DONE",
                nextRunAt: next,
                lastRunAt: now,
                runCount: { increment: 1 },
                lastResult: { startedAt: now.toISOString(), broadcasts: result.started, total: result.total, invalid: result.invalid.length, rejectedSessions: result.rejectedSessions, failures: result.failures } as any,
                lastError: null
            }
        });
        logger.info("Campaign", `"${c.name}" started: ${result.total} recipient(s) on ${result.started.length} number(s)${next ? `, next ${next.toISOString()}` : ""}`);
    } catch (e: any) {
        await finishWithError(c, now, e?.message || "Failed to start", nextOccurrence());
    }
}

async function finishWithError(c: DueCampaign, now: Date, message: string, next: Date | null) {
    await prisma.campaign.update({
        where: { id: c.id },
        data: { status: next ? "SCHEDULED" : "FAILED", nextRunAt: next, lastRunAt: now, lastError: message }
    }).catch(() => {});
    logger.warn("Campaign", `"${c.name}" did not start: ${message}`);
    await sendAlert({
        kind: "broadcast",
        title: `Campaign "${c.name}" did not start`,
        message: `${message}.${next ? ` Next attempt: ${next.toLocaleString("en-IN", { timeZone: c.timezone || undefined })}.` : " Open Broadcast → Campaigns to reschedule."}`,
        userId: c.userId,
        href: "/dashboard/broadcast",
        dedupeKey: `campaign-fail:${c.id}:${now.toISOString().slice(0, 13)}`
    }).catch(() => {});
}

/** After a restart: campaigns stuck in RUNNING never finished their start. Put them back or fail them. */
export async function recoverStaleCampaigns() {
    const stuck = await prisma.campaign.findMany({ where: { status: "RUNNING" }, select: { id: true, cronExpression: true, timezone: true } });
    if (stuck.length === 0) return;
    const tz = await getSystemTimezone();
    for (const c of stuck) {
        const next = c.cronExpression ? nextRunAfter(c.cronExpression, c.timezone || tz, new Date()) : null;
        await prisma.campaign.update({
            where: { id: c.id },
            data: { status: next ? "SCHEDULED" : "FAILED", nextRunAt: next, lastError: "Server restarted while this campaign was starting" }
        }).catch(() => {});
    }
    logger.warn("Campaign", `${stuck.length} campaign(s) were interrupted by the restart`);
}
