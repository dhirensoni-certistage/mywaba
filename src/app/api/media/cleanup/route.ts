import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { findRemovableFiles, MEDIA_DIR, runMediaCleanup, getMediaRetentionDays } from "@/lib/media-cleanup";

/**
 * GET  /api/media/cleanup  → what the nightly clean-up would delete right now (superadmin)
 * POST /api/media/cleanup  → run it now; body { dryRun?: boolean, retentionDays?: number } (superadmin)
 */
export async function GET(request: NextRequest) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    if (user.role !== "SUPERADMIN") return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });

    const retentionDays = await getMediaRetentionDays();
    const cfg = await prisma.systemConfig.findUnique({ where: { id: "default" }, select: { mediaLastCleanupAt: true, mediaLastCleanupResult: true } }).catch(() => null);
    const preview = await findRemovableFiles(MEDIA_DIR, retentionDays);
    return NextResponse.json({
        status: true,
        message: "Media clean-up status",
        data: {
            retentionDays,
            lastCleanupAt: cfg?.mediaLastCleanupAt ?? null,
            lastResult: cfg?.mediaLastCleanupResult ?? null,
            scanned: preview.scanned,
            expiredCount: preview.expired.length,
            expiredBytes: preview.expired.reduce((a, f) => a + f.size, 0),
            orphanCount: preview.orphans.length,
            orphanBytes: preview.orphans.reduce((a, f) => a + f.size, 0)
        }
    });
}

export async function POST(request: NextRequest) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    if (user.role !== "SUPERADMIN") return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const retentionDays = body?.retentionDays !== undefined ? Math.max(0, Math.floor(Number(body.retentionDays)) || 0) : undefined;
    const result = await runMediaCleanup({ dryRun: Boolean(body?.dryRun), retentionDays, includeOrphans: body?.includeOrphans !== false, trigger: "manual" });
    const mb = (result.freedBytes / 1024 / 1024).toFixed(1);
    const parts = [`${result.deleted} file(s) older than ${result.retentionDays} days`, `${result.orphansDeleted} file(s) of deleted sessions`];
    const message = result.skipped
        ? `Clean-up skipped: ${result.skipped}`
        : result.dryRun
            ? `${parts.join(" + ")} (${mb} MB) would be deleted`
            : result.deleted + result.orphansDeleted === 0
                ? `Nothing to delete: no file is older than ${result.retentionDays} days and no file belongs to a deleted session`
                : `Deleted ${parts.join(" + ")}, freed ${mb} MB, detached ${result.messagesUpdated} message(s)`;
    return NextResponse.json({ status: true, message, data: result });
}
