/**
 * Automatic clean-up of downloaded chat media.
 *
 * Every incoming/outgoing image, video, audio and document is downloaded to data/media so the
 * dashboard can show it (see downloadAndSaveMedia in webhook.ts). Nothing ever removed those files:
 * one VPS had 12,500 of them after a few weeks, which eats disk and slows every build (Turbopack
 * traces the folder). This job deletes files older than `SystemConfig.mediaRetentionDays` (default
 * 30, 0 = keep forever) once a night and clears `Message.mediaUrl` for them so the chat view shows
 * a message without a broken attachment instead of a 404.
 *
 * Only data/media is touched. Files in uploads/ (user uploads used by auto-replies, scheduled
 * messages and broadcasts) are never deleted automatically.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export const MEDIA_DIR = path.join(process.cwd(), "data", "media");
export const MAX_RETENTION_DAYS = 3650;

export interface CleanupResult {
    retentionDays: number;
    scanned: number;
    deleted: number;
    freedBytes: number;
    messagesUpdated: number;
    dryRun: boolean;
    skipped?: string;
}

export interface ExpiredFile { name: string; size: number; mtimeMs: number }

/** Files in `dir` whose modification time is older than `days` days (pure scan, no deletion). */
export async function findExpiredFiles(dir: string, days: number, now = Date.now()): Promise<{ scanned: number; expired: ExpiredFile[] }> {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    let names: string[] = [];
    try {
        names = (await readdir(dir)).filter(n => n !== ".gitkeep" && !n.startsWith("."));
    } catch {
        return { scanned: 0, expired: [] };
    }
    const expired: ExpiredFile[] = [];
    for (const name of names) {
        try {
            const st = await stat(path.join(dir, name));
            if (!st.isFile()) continue;
            if (st.mtimeMs < cutoff) expired.push({ name, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* file vanished meanwhile */ }
    }
    return { scanned: names.length, expired };
}

export async function getMediaRetentionDays(): Promise<number> {
    try {
        const cfg = await prisma.systemConfig.findUnique({ where: { id: "default" }, select: { mediaRetentionDays: true } });
        return normalizeRetentionDays(cfg?.mediaRetentionDays ?? 30);
    } catch {
        return 30;
    }
}

export function normalizeRetentionDays(value: unknown): number {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return 30;
    return Math.min(n, MAX_RETENTION_DAYS);
}

let running = false;

/**
 * Delete expired media and detach it from messages. Safe to call from the cron and from the API
 * at the same time: a second call while one is running returns immediately.
 */
export async function runMediaCleanup(opts: { dryRun?: boolean; retentionDays?: number } = {}): Promise<CleanupResult> {
    const retentionDays = opts.retentionDays ?? await getMediaRetentionDays();
    const dryRun = Boolean(opts.dryRun);
    const base: CleanupResult = { retentionDays, scanned: 0, deleted: 0, freedBytes: 0, messagesUpdated: 0, dryRun };

    if (retentionDays <= 0) return { ...base, skipped: "retention disabled (0 days)" };
    if (running) return { ...base, skipped: "a clean-up is already running" };
    running = true;
    const started = Date.now();
    try {
        const { scanned, expired } = await findExpiredFiles(MEDIA_DIR, retentionDays);
        base.scanned = scanned;
        if (expired.length === 0) {
            if (!dryRun) await touchLastCleanup();
            return base;
        }
        if (dryRun) {
            return { ...base, deleted: expired.length, freedBytes: expired.reduce((a, f) => a + f.size, 0) };
        }

        const removedUrls: string[] = [];
        for (const f of expired) {
            try {
                await unlink(path.join(MEDIA_DIR, f.name));
                base.deleted++;
                base.freedBytes += f.size;
                removedUrls.push(`/api/media/${f.name}`);
            } catch (e) {
                logger.debug("MediaCleanup", `could not delete ${f.name}`, e);
            }
        }

        // Detach the deleted files from their messages, in chunks so the IN() list stays small.
        for (let i = 0; i < removedUrls.length; i += 500) {
            const chunk = removedUrls.slice(i, i + 500);
            try {
                const r = await prisma.message.updateMany({ where: { mediaUrl: { in: chunk } }, data: { mediaUrl: null } });
                base.messagesUpdated += r.count;
            } catch (e) {
                logger.warn("MediaCleanup", "failed to clear mediaUrl on messages", e);
            }
        }
        await touchLastCleanup();
        logger.info("MediaCleanup", `Deleted ${base.deleted} file(s) older than ${retentionDays} days (${(base.freedBytes / 1024 / 1024).toFixed(1)} MB freed, ${base.messagesUpdated} message(s) detached, ${Date.now() - started} ms)`);
        return base;
    } finally {
        running = false;
    }
}

async function touchLastCleanup() {
    await prisma.systemConfig.update({ where: { id: "default" }, data: { mediaLastCleanupAt: new Date() } }).catch(() => {});
}
