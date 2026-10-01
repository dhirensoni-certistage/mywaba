import { prisma } from "./prisma";
import { logger } from "./logger";

/**
 * Outbound alerts for things an operator must know about even when the dashboard is closed:
 * session logged out / auto-stopped, a broadcast that stopped or had failures, and a daily
 * send budget that is nearly used up.
 *
 * Channels (configured by a SUPERADMIN in Settings → Alerts):
 *  - Telegram bot (token + chat id) — no extra setup beyond creating a bot with @BotFather
 *  - Email via SMTP_* environment variables (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE)
 * Every alert is also stored as a dashboard notification for the session owner when a userId is given.
 */

export type AlertKind = "logout" | "broadcast" | "limit" | "test";

interface AlertSettings {
    alertsEnabled: boolean;
    alertTelegramToken: string | null;
    alertTelegramChatId: string | null;
    alertEmail: string | null;
    alertOnLogout: boolean;
    alertOnBroadcast: boolean;
    alertOnLimit: boolean;
}

let settingsCache: { value: AlertSettings; at: number } | null = null;
const SETTINGS_TTL_MS = 30_000;

export function invalidateAlertSettings() {
    settingsCache = null;
}

async function getSettings(): Promise<AlertSettings> {
    if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
    const cfg = await prisma.systemConfig.findUnique({ where: { id: "default" } }).catch(() => null);
    const value: AlertSettings = {
        alertsEnabled: cfg?.alertsEnabled ?? true,
        alertTelegramToken: cfg?.alertTelegramToken || null,
        alertTelegramChatId: cfg?.alertTelegramChatId || null,
        alertEmail: cfg?.alertEmail || null,
        alertOnLogout: cfg?.alertOnLogout ?? true,
        alertOnBroadcast: cfg?.alertOnBroadcast ?? true,
        alertOnLimit: cfg?.alertOnLimit ?? true,
    };
    settingsCache = { value, at: Date.now() };
    return value;
}

export function smtpConfigured(): boolean {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function sendTelegram(token: string, chatId: string, text: string) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Telegram ${res.status}: ${body.slice(0, 200)}`);
    }
}

async function sendEmail(to: string, subject: string, text: string) {
    if (!smtpConfigured()) throw new Error("SMTP_HOST / SMTP_USER / SMTP_PASS are not set in .env");
    const nodemailer = await import("nodemailer");
    const port = parseInt(process.env.SMTP_PORT || "587", 10);
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE === "true" || port === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: to.split(",").map(s => s.trim()).filter(Boolean),
        subject,
        text
    });
}

function escapeHtml(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Simple de-duplication so a flapping session does not spam the channel
const recent = new Map<string, number>();
const DEDUPE_MS = 5 * 60 * 1000;

export interface AlertInput {
    kind: AlertKind;
    title: string;
    message: string;
    /** Session owner to notify in the dashboard as well. */
    userId?: string | null;
    href?: string;
    /** Key used to suppress identical alerts within 5 minutes. */
    dedupeKey?: string;
}

/**
 * Fire an alert on every configured channel. Never throws; failures are logged.
 * Returns which channels were attempted and whether each succeeded.
 */
export async function sendAlert(input: AlertInput): Promise<{ telegram?: boolean; email?: boolean; dashboard?: boolean; skipped?: string }> {
    const result: { telegram?: boolean; email?: boolean; dashboard?: boolean; skipped?: string } = {};
    try {
        const s = await getSettings();
        const isTest = input.kind === "test";
        if (!isTest) {
            if (!s.alertsEnabled) return { skipped: "alerts disabled" };
            if (input.kind === "logout" && !s.alertOnLogout) return { skipped: "logout alerts disabled" };
            if (input.kind === "broadcast" && !s.alertOnBroadcast) return { skipped: "broadcast alerts disabled" };
            if (input.kind === "limit" && !s.alertOnLimit) return { skipped: "limit alerts disabled" };
            const key = input.dedupeKey || `${input.kind}:${input.title}`;
            const last = recent.get(key) || 0;
            if (Date.now() - last < DEDUPE_MS) return { skipped: "duplicate within 5 minutes" };
            recent.set(key, Date.now());
        }

        const appName = process.env.APP_NAME || "WABA";
        const plain = `[${appName}] ${input.title}\n\n${input.message}`;
        const html = `<b>[${escapeHtml(appName)}] ${escapeHtml(input.title)}</b>\n\n${escapeHtml(input.message)}`;

        if (s.alertTelegramToken && s.alertTelegramChatId) {
            try { await sendTelegram(s.alertTelegramToken, s.alertTelegramChatId, html); result.telegram = true; }
            catch (e: any) { result.telegram = false; logger.error("Alerts", `Telegram failed: ${e?.message || e}`); }
        }
        if (s.alertEmail) {
            try { await sendEmail(s.alertEmail, `[${appName}] ${input.title}`, plain); result.email = true; }
            catch (e: any) { result.email = false; logger.error("Alerts", `Email failed: ${e?.message || e}`); }
        }
        if (input.userId && !isTest) {
            try {
                const n = await prisma.notification.create({
                    data: { userId: input.userId, title: input.title, message: input.message, type: "WARNING", href: input.href || "/dashboard/broadcast" }
                });
                const io = (global as any).io;
                io?.to(`user:${input.userId}`).emit("notification:new", { id: n.id, userId: input.userId, title: n.title, message: n.message, type: n.type, href: n.href, createdAt: n.createdAt });
                result.dashboard = true;
            } catch { result.dashboard = false; }
        }
    } catch (e) {
        logger.error("Alerts", "sendAlert error", e);
    }
    return result;
}
