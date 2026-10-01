import { logger } from "@/lib/logger";
import { waManager } from "./manager";

/**
 * "Is this number on WhatsApp?" lookups with a per-session cache.
 *
 * onWhatsApp() is itself a signal WhatsApp watches, so we never check the same number twice
 * within 24h, and we check in small chunks with a short pause between them. Used by the
 * pre-check dialog on the Broadcast page and by the engine's validation phase.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CHUNK_SIZE = 10;
const CHUNK_PAUSE_MS = 400;

type Entry = { exists: boolean; jid: string | null; at: number };
const cache = new Map<string, Map<string, Entry>>();

function sessionCache(sessionId: string) {
    let m = cache.get(sessionId);
    if (!m) { m = new Map(); cache.set(sessionId, m); }
    return m;
}

export function digitsOf(numberOrJid: string): string {
    return numberOrJid.split("@")[0].replace(/:\d+$/, "").replace(/[^0-9]/g, "");
}

export interface NumberCheckResult {
    number: string;
    exists: boolean;
    jid: string | null;
    cached: boolean;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Check a list of numbers (digits or JIDs). Group/LID JIDs are reported as existing without
 * a lookup. Throws if the session is not connected.
 */
export async function checkNumbers(sessionId: string, inputs: string[], opts: { onProgress?: (done: number, total: number) => void } = {}): Promise<NumberCheckResult[]> {
    const instance = waManager.getInstance(sessionId);
    if (!instance?.socket || instance.status !== "CONNECTED") {
        throw new Error("Session not connected");
    }
    const sock = instance.socket;
    const store = sessionCache(sessionId);
    const now = Date.now();

    const results = new Map<string, NumberCheckResult>();
    const toLookup: string[] = [];
    for (const raw of inputs) {
        if (raw.includes("@") && !raw.endsWith("@s.whatsapp.net")) {
            results.set(raw, { number: raw, exists: true, jid: raw, cached: true });
            continue;
        }
        const n = digitsOf(raw);
        if (!n) { results.set(raw, { number: raw, exists: false, jid: null, cached: true }); continue; }
        const hit = store.get(n);
        if (hit && now - hit.at < CACHE_TTL_MS) {
            results.set(raw, { number: n, exists: hit.exists, jid: hit.jid, cached: true });
        } else if (!toLookup.includes(n)) {
            toLookup.push(n);
        }
    }

    let done = 0;
    for (let i = 0; i < toLookup.length; i += CHUNK_SIZE) {
        const chunk = toLookup.slice(i, i + CHUNK_SIZE);
        try {
            const res = (await sock.onWhatsApp(...chunk)) || [];
            const found = new Map<string, string>();
            for (const r of res) {
                if (r?.exists && r.jid) found.set(digitsOf(r.jid), r.jid);
            }
            for (const n of chunk) {
                const jid = found.get(n) || null;
                store.set(n, { exists: !!jid, jid, at: Date.now() });
            }
        } catch (e: any) {
            // Lookup failure is not "not on WhatsApp" — leave these unknown (treated as existing) and don't cache.
            logger.warn("NumberCheck", `onWhatsApp failed for a chunk of ${chunk.length}: ${e?.message || e}`);
            for (const n of chunk) {
                if (!store.has(n)) results.set(n, { number: n, exists: true, jid: `${n}@s.whatsapp.net`, cached: false });
            }
        }
        done += chunk.length;
        opts.onProgress?.(done, toLookup.length);
        if (i + CHUNK_SIZE < toLookup.length) await sleep(CHUNK_PAUSE_MS);
    }

    // Fill from cache for everything we looked up (keeps input order)
    const out: NumberCheckResult[] = [];
    for (const raw of inputs) {
        const direct = results.get(raw);
        if (direct) { out.push(direct); continue; }
        const n = digitsOf(raw);
        const hit = store.get(n);
        if (hit) out.push({ number: n, exists: hit.exists, jid: hit.jid, cached: false });
        else out.push({ number: n, exists: true, jid: `${n}@s.whatsapp.net`, cached: false });
    }
    return out;
}

/** Drop cached results for a session (e.g. after re-linking). */
export function clearNumberCache(sessionId?: string) {
    if (sessionId) cache.delete(sessionId);
    else cache.clear();
}
