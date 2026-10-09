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

/**
 * Warm-up schedule for a new number: daily cap by day since warm-up started.
 * After the last step the configured daily limit applies.
 */
export const WARMUP_SCHEDULE: { untilDay: number; cap: number }[] = [
    { untilDay: 3, cap: 20 },
    { untilDay: 7, cap: 50 },
    { untilDay: 14, cap: 100 },
    { untilDay: 21, cap: 150 },
];
export const WARMUP_DAYS = WARMUP_SCHEDULE[WARMUP_SCHEDULE.length - 1].untilDay;

export function warmupDay(startedAt: Date | null | undefined, now = new Date()): number {
    if (!startedAt) return 1;
    return Math.max(1, Math.floor((now.getTime() - startedAt.getTime()) / 86400000) + 1);
}

/** Cap for the given warm-up day, or null once warm-up is over. */
export function warmupCapForDay(day: number): number | null {
    for (const step of WARMUP_SCHEDULE) if (day <= step.untilDay) return step.cap;
    return null;
}

export interface EffectiveLimit {
    /** 0 = unlimited */
    limit: number;
    source: "warmup" | "daily" | "none";
    warmupDay: number | null;
    warmupCap: number | null;
}

/** The limit that actually applies today: the warm-up cap while warming up, else the daily limit. */
export function effectiveDailyLimit(cfg: { dailyBroadcastLimit: number; warmupEnabled: boolean; warmupStartedAt: Date | null }, now = new Date()): EffectiveLimit {
    if (cfg.warmupEnabled) {
        const day = warmupDay(cfg.warmupStartedAt, now);
        const cap = warmupCapForDay(day);
        if (cap !== null) {
            const limit = cfg.dailyBroadcastLimit > 0 ? Math.min(cap, cfg.dailyBroadcastLimit) : cap;
            return { limit, source: "warmup", warmupDay: day, warmupCap: cap };
        }
        return { limit: cfg.dailyBroadcastLimit, source: cfg.dailyBroadcastLimit > 0 ? "daily" : "none", warmupDay: day, warmupCap: null };
    }
    return { limit: cfg.dailyBroadcastLimit, source: cfg.dailyBroadcastLimit > 0 ? "daily" : "none", warmupDay: null, warmupCap: null };
}

export interface SafetyConfig {
    dailyBroadcastLimit: number;
    warmupEnabled: boolean;
    warmupStartedAt: Date | null;
    broadcastPausedUntil: Date | null;
    broadcastPauseReason: string | null;
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
        warmupEnabled: Boolean(botConfig?.warmupEnabled),
        warmupStartedAt: botConfig?.warmupStartedAt ? new Date(botConfig.warmupStartedAt) : null,
        broadcastPausedUntil: botConfig?.broadcastPausedUntil ? new Date(botConfig.broadcastPausedUntil) : null,
        broadcastPauseReason: botConfig?.broadcastPauseReason || null,
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
export type TemplateVars = Record<string, string | null | undefined>;

/** Lower-cased, trimmed copy of the vars so `{Name}` and `{ name }` both resolve. */
export function normalizeVars(vars: TemplateVars | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!vars) return out;
    for (const [k, v] of Object.entries(vars)) {
        const key = k.trim().toLowerCase();
        if (!key) continue;
        if (v === null || v === undefined) continue;
        out[key] = String(v).trim();
    }
    return out;
}

export function personalize(template: string, vars: TemplateVars): string {
    if (!template || !template.includes("{")) return template;
    const values = normalizeVars(vars);
    const out = template.replace(/\{([^{}]*)\}/g, (whole, inner: string) => {
        const parts = inner.split("|");
        const key = parts[0].trim().toLowerCase();
        // `{column}` or `{column|fallback}` — any uploaded column, "name" included
        if (key && Object.prototype.hasOwnProperty.call(values, key)) {
            const fallback = parts.slice(1).join("|").trim();
            return values[key] || fallback;
        }
        if (key === "name") {
            // no name known for this recipient — use the fallback if given
            return parts.slice(1).join("|").trim();
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

const AUTO_GREETINGS = ["Namaste", "Namaskar", "Hello", "Hi", "Hii", "Hey", "Hello ji", "Namaste ji", "Namaskar ji", "Hi there", "Dear", "Good day", "Pranam", "Greetings"];
const AUTO_GREETING_TAILS = ["!", ",", " 🙏", " 😊", "! 🙏", ", 🙏", " 🌸", " ✨", "!!", " 🙏🙏"];
/** Second line of the opener (used most of the time) — generic, true for any broadcast. */
const AUTO_INTROS = [
    "Umeed hai aap theek honge.", "Aasha hai aap sab kushal mangal honge.", "Umeed hai aapka din accha ja raha hai.",
    "Hope you are doing well.", "Hope this message finds you well.", "Trust you are doing great.",
    "Aapke liye ek khaas update hai.", "Aapke liye ek chhoti si jaankari.", "Ek zaroori baat aapke saath share karni thi.",
    "Aapke liye kuch khaas laaye hain.", "Ek update aapke liye.", "Aapko ye batate hue khushi ho rahi hai.",
    "Bas ek minute ka samay chahiye.", "Ek chhota sa message aapke liye.", "Aapke saath ek baat share karni hai.",
    "Sharing a quick update with you.", "A small update for you.", "Just a quick note for you.",
    "Aap kaise hain? Ek update hai.", "Aapka din shubh ho.", "Aapke liye ek special sandesh.",
    "Kya haal hain? Ek baat batani thi.", "Aapke liye ek acchi khabar hai.", "Hum aapke liye kuch khaas laaye hain.",
    "Aapka swagat hai is update ke saath.", "Ek baar zaroor padhein.", "Thoda samay nikaal kar ye zaroor dekhein.",
    "Aapke liye ye jaankari zaroori hai.", "Good news aapke liye.", "Here is something for you."
];
const AUTO_CLOSINGS = [
    "Dhanyawad 🙏", "Thank you!", "Shukriya 🙏", "Thanks 😊", "Dhanyawad!", "Thank you 🙏", "🙏",
    "Aapka din shubh ho 🌸", "Have a great day!", "Aapka dhanyawad 🙏", "Bahut bahut dhanyawad 🙏",
    "Aapke jawab ka intezaar rahega.", "Koi sawaal ho to zaroor batayein.", "Reply karke batayein 😊",
    "Aapka aabhar 🙏", "Many thanks!", "Thanks a lot 🙏", "Shubh din 🌼", "Milte hain! 😊",
    "Aapka samay dene ke liye dhanyawad 🙏", "Thank you for your time!", "Sadar dhanyawad 🙏",
    "Aapka apna, hamesha 🙏", "Khush rahiye 😊", "Take care! 🌸", "Dhanyawad, aapka din accha ho ✨"
];

function pick<T>(list: T[]): T { return list[Math.floor(Math.random() * list.length)]; }

/**
 * Auto-vary: make every copy of a broadcast text different without the sender writing spintax.
 * Identical texts to many people are one of WhatsApp's strongest spam signals; the first and
 * last lines are what the filter compares most, so every copy gets its own.
 *
 * Always adds (whatever the text already starts or ends with — the owner's choice):
 *  - an opener on top: random greeting (with the recipient's name when known) + random tail,
 *    followed most of the time by one of many random intro sentences;
 *  - a random closing line at the bottom.
 * Hundreds of combinations, so no two recipients get the same message.
 */
export function autoVaryText(text: string, vars: TemplateVars | null | undefined): string {
    const body = (text || "").trim();
    if (!body) return text;
    const name = normalizeVars(vars).name || "";
    // "Hello ji Rahul" reads wrong — the "ji" variants are for recipients without a name.
    const greeting = name ? pick(AUTO_GREETINGS.filter(g => !/ ji$/.test(g))) : pick(AUTO_GREETINGS.filter(g => g !== "Dear"));
    let opener = `${greeting}${name ? ` ${name}` : ""}${pick(AUTO_GREETING_TAILS)}`;
    if (Math.random() < 0.8) opener += `\n${pick(AUTO_INTROS)}`;
    return [opener, body, pick(AUTO_CLOSINGS)].join("\n\n");
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


/** Is broadcasting currently auto-paused for this session? */
export function isBroadcastPaused(safety: SafetyConfig, now = new Date()): boolean {
    return !!safety.broadcastPausedUntil && safety.broadcastPausedUntil.getTime() > now.getTime();
}

/** Pause broadcasting on a session (delivery monitor) — stored on BotConfig so it survives restarts. */
export async function pauseBroadcasts(sessionId: string, hours: number, reason: string) {
    const until = new Date(Date.now() + hours * 3600 * 1000);
    await prisma.botConfig.updateMany({
        where: { session: { sessionId } },
        data: { broadcastPausedUntil: until, broadcastPauseReason: reason }
    }).catch(() => {});
    return until;
}

export async function resumeBroadcasts(sessionId: string) {
    await prisma.botConfig.updateMany({
        where: { session: { sessionId } },
        data: { broadcastPausedUntil: null, broadcastPauseReason: null }
    }).catch(() => {});
}

export interface EngagementStats {
    windowHours: number;
    sent: number;
    delivered: number;
    read: number;
    replied: number;
    /** Sent more than 10 minutes ago and still without a delivery receipt */
    undeliveredStale: number;
    staleBase: number;
    deliveredRate: number | null;
    readRate: number | null;
    replyRate: number | null;
    undeliveredStaleRate: number | null;
}

/** Delivery / read / reply rates for this session's broadcasts in the trailing window. */
export async function getEngagementStats(sessionId: string, windowHours = 24 * 7): Promise<EngagementStats> {
    const since = new Date(Date.now() - windowHours * 3600 * 1000);
    const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
    const base = { status: "sent", sentAt: { gte: since }, broadcastLog: { sessionId } } as const;
    const [sent, delivered, read, replied, staleBase, undeliveredStale] = await Promise.all([
        prisma.broadcastRecipient.count({ where: base }),
        prisma.broadcastRecipient.count({ where: { ...base, deliveryStatus: { in: ["DELIVERED", "READ"] } } }),
        prisma.broadcastRecipient.count({ where: { ...base, deliveryStatus: "READ" } }),
        prisma.broadcastRecipient.count({ where: { ...base, repliedAt: { not: null } } }),
        prisma.broadcastRecipient.count({ where: { ...base, sentAt: { gte: since, lte: staleBefore } } }),
        prisma.broadcastRecipient.count({ where: { ...base, sentAt: { gte: since, lte: staleBefore }, OR: [{ deliveryStatus: null }, { deliveryStatus: "SENT" }] } }),
    ]);
    const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
    return {
        windowHours, sent, delivered, read, replied, undeliveredStale, staleBase,
        deliveredRate: rate(delivered, sent), readRate: rate(read, sent), replyRate: rate(replied, sent),
        undeliveredStaleRate: rate(undeliveredStale, staleBase)
    };
}

/** Thresholds for the delivery monitor. */
export const MONITOR = {
    /** Minimum sends (older than 10 min) before judging delivery collapse */
    MIN_STALE_SAMPLE: 30,
    /** % of 10-min-old sends still without a receipt that triggers auto-pause */
    UNDELIVERED_PAUSE_PCT: 70,
    /** Hours to pause after a collapse */
    PAUSE_HOURS: 12,
    /** Low-engagement warning: sends in 24h needed and reply % below which to warn */
    LOW_REPLY_MIN_SENT: 100,
    LOW_REPLY_PCT: 1,
};
