import cron from "node-cron";
import cronParser from "cron-parser";
import { prisma } from "@/lib/prisma";
import { waManager } from "@/modules/whatsapp/manager";
import { logger } from "./logger";
import { getEngagementStats, MONITOR } from "@/modules/whatsapp/safety";
import { sendAlert } from "./alerts";

/**
 * Scheduled-message runner.
 *
 * This is the ONLY scheduler. Previously a second poller (src/modules/whatsapp/scheduler.ts,
 * every 30s) ran alongside this one, so every due message was queried twice a minute and could
 * be sent twice when both pollers picked it up before either marked it SENT.
 *
 * Each message is now claimed atomically (PENDING -> SENDING) before sending, and a tick that
 * is still running when the next one fires is skipped.
 */

let tickRunning = false;

async function resolveTimezone(): Promise<string> {
    try {
        const cfg = await prisma.systemConfig.findUnique({ where: { id: "default" }, select: { timezone: true } });
        if (cfg?.timezone) return cfg.timezone;
    } catch { /* ignore */ }
    return process.env.TZ || "Asia/Kolkata";
}

function toAbsoluteUrl(url: string): string {
    if (url.startsWith("/")) {
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3030}`;
        return `${baseUrl.replace(/\/$/, "")}${url}`;
    }
    return url;
}

async function buildContent(msg: { content: string | null; mediaUrl: string | null; mediaType: string | null }) {
    if (!msg.mediaUrl) {
        return { text: msg.content || "" };
    }

    const url = toAbsoluteUrl(msg.mediaUrl);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch media from URL: ${res.status} ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
    const fileName = decodeURIComponent(url.split("/").pop() || "file").split("?")[0] || "file";
    const type = (msg.mediaType || "image").toLowerCase();
    const caption = msg.content || "";

    if (type === "video") return { video: buffer, caption, mimetype: contentType || "video/mp4" };
    if (type === "audio") return { audio: buffer, mimetype: contentType || "audio/mp4" };
    if (type === "document") return { document: buffer, caption, mimetype: contentType || "application/octet-stream", fileName };
    return { image: buffer, caption };
}

export async function runSchedulerTick() {
    if (tickRunning) {
        logger.debug("Cron", "Previous scheduler tick still running, skipping");
        return;
    }
    tickRunning = true;
    try {
        const now = new Date();

        const pendingMessages = await prisma.scheduledMessage.findMany({
            where: { status: "PENDING", sendAt: { lte: now } },
            include: { session: { select: { sessionId: true } } }
        });

        if (pendingMessages.length === 0) return;

        logger.info("Cron", `Found ${pendingMessages.length} scheduled message(s) due`);
        const timezone = await resolveTimezone();

        for (const msg of pendingMessages) {
            const instance = waManager.getInstance(msg.session.sessionId);

            if (!instance?.socket || instance.status !== "CONNECTED") {
                // Keep PENDING so it retries on the next tick once the session is back.
                logger.warn("Cron", `Session ${msg.session.sessionId} not connected. Scheduled msg ${msg.id} deferred.`);
                continue;
            }

            // Atomic claim — guarantees a single sender even if two ticks overlap.
            const claimed = await prisma.scheduledMessage.updateMany({
                where: { id: msg.id, status: "PENDING" },
                data: { status: "SENDING" }
            });
            if (claimed.count !== 1) continue;

            const nextRun = () => {
                if (!msg.cronExpression) return null;
                try {
                    return cronParser.parse(msg.cronExpression, { tz: timezone }).next().toDate();
                } catch (e) {
                    logger.error("Cron", `Invalid cron expression on ${msg.id}: ${msg.cronExpression}`);
                    return null;
                }
            };

            try {
                const content = await buildContent(msg);
                await instance.socket.sendMessage(msg.jid, content as any);
                logger.success("Cron", `Scheduled msg ${msg.id} sent to ${msg.jid}`);

                const next = nextRun();
                await prisma.scheduledMessage.update({
                    where: { id: msg.id },
                    data: next ? { status: "PENDING", sendAt: next } : { status: "SENT" }
                });
            } catch (error) {
                logger.error("Cron", `Failed to send scheduled msg ${msg.id}`, error);
                const next = nextRun();
                await prisma.scheduledMessage.update({
                    where: { id: msg.id },
                    data: next ? { status: "PENDING", sendAt: next } : { status: "FAILED" }
                }).catch(() => {});
            }
        }
    } catch (error) {
        logger.error("Cron", "Scheduler error:", error);
    } finally {
        tickRunning = false;
    }
}

// `var` on purpose: manager.ts imports this module and calls initScheduler() from its singleton
// constructor, which can run while this module is still evaluating (circular import). A `let`
// would be in its temporal dead zone at that moment; `var` is hoisted as undefined (falsy).
// eslint-disable-next-line no-var
var initialized = false;

export function initScheduler() {
    if (initialized) return;
    initialized = true;

    // Anything left in SENDING from a crash mid-send goes back to PENDING so it is retried.
    prisma.scheduledMessage.updateMany({
        where: { status: "SENDING" },
        data: { status: "PENDING" }
    }).catch(() => {});

    // Run every minute
    cron.schedule("* * * * *", () => { runSchedulerTick(); });

    // Engagement monitor: every 30 minutes, warn once a day per session when a lot was sent and almost nobody replied
    cron.schedule("*/30 * * * *", () => { runEngagementMonitor().catch(e => logger.error("Monitor", "engagement monitor failed", e)); });

    logger.info("Cron", "Scheduler initialized");
}


export async function runEngagementMonitor() {
    const sessions = await prisma.session.findMany({
        where: { status: "CONNECTED" },
        select: { sessionId: true, userId: true }
    });
    const today = new Date().toISOString().slice(0, 10);
    for (const s of sessions) {
        try {
            const stats = await getEngagementStats(s.sessionId, 24);
            if (stats.sent >= MONITOR.LOW_REPLY_MIN_SENT && stats.replyRate !== null && stats.replyRate < MONITOR.LOW_REPLY_PCT) {
                await sendAlert({
                    kind: "limit",
                    title: `${s.sessionId}: very low engagement (${stats.replyRate}% replies on ${stats.sent} sends in 24h)`,
                    message: `Delivered ${stats.deliveredRate ?? "?"}%, read ${stats.readRate ?? "?"}%, replied ${stats.replyRate}%. Lists with almost no replies are how numbers get reported. Consider pausing, cleaning the list, personalising the text and sending only to people who know you.`,
                    userId: s.userId,
                    href: "/dashboard/broadcast",
                    dedupeKey: `lowreply:${s.sessionId}:${today}`
                });
            }
        } catch (e) {
            logger.debug("Monitor", `engagement check failed for ${s.sessionId}`, e);
        }
    }
}
