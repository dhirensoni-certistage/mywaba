import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { startBroadcast, type RecipientInput } from "@/modules/whatsapp/broadcast";

/**
 * POST /api/messages/:sessionId/broadcast/:broadcastId/retry
 *
 * Starts a new broadcast with the same message/media/options for the recipients of the given
 * broadcast that were NOT delivered and can still be delivered:
 *   included → failed because of connection loss, logout, cancellation, daily limit, server restart, send errors
 *   excluded → "not registered on WhatsApp", "opted out" (permanent), and anything already sent
 * Body (optional): { includePermanent?: boolean } to also retry the permanent ones (not recommended).
 */
const PERMANENT = /not registered on WhatsApp|opted out/i;

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; broadcastId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }
        const { sessionId, broadcastId } = await params;
        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });
        }

        const body = await request.json().catch(() => ({}));
        const includePermanent = Boolean(body?.includePermanent);

        const log = await prisma.broadcastLog.findFirst({
            where: { id: broadcastId, sessionId },
            include: { recipients: true }
        });
        if (!log) {
            return NextResponse.json({ status: false, message: "Broadcast not found" }, { status: 404 });
        }
        if (log.status === "running") {
            return NextResponse.json({ status: false, message: "Broadcast is still running — stop it first" }, { status: 409 });
        }

        const retryable = log.recipients.filter(r =>
            r.status !== "sent" && (includePermanent || !PERMANENT.test(r.error || ""))
        );
        const permanentSkipped = log.recipients.filter(r => r.status !== "sent" && PERMANENT.test(r.error || "")).length;

        if (retryable.length === 0) {
            return NextResponse.json({
                status: false,
                message: permanentSkipped > 0
                    ? `Nothing to retry: the ${permanentSkipped} remaining failure(s) are permanent (not on WhatsApp / opted out).`
                    : "Nothing to retry — every recipient was sent."
            }, { status: 400 });
        }

        const opts = (log.options as any) || {};
        const recipients: RecipientInput[] = retryable.map(r => ({ jid: r.jid, vars: (r.vars as any) || undefined }));
        const isMediaPlaceholder = /^\[Media: [^\]]+\]$/.test(log.message);

        const result = await startBroadcast({
            sessionId,
            recipients,
            message: isMediaPlaceholder ? "" : log.message,
            mediaUrl: log.mediaUrl,
            mediaType: log.mediaType,
            delay: log.delay,
            batchSize: opts.batchSize,
            batchPauseMs: opts.batchPauseMs,
            simulateTyping: opts.simulateTyping,
            validateNumbers: opts.validateNumbers,
            shuffle: opts.shuffle,
            spreadHours: opts.spreadHours,
            buttons: opts.buttons,
            footer: opts.footer || undefined,
            retryOf: log.id
        });

        return NextResponse.json({
            status: true,
            message: `Retrying ${result.total} recipient(s)${permanentSkipped ? ` (${permanentSkipped} permanent failure(s) skipped)` : ""}`,
            data: { broadcastId: result.broadcastId, total: result.total, permanentSkipped, retryOf: log.id }
        });
    } catch (e: any) {
        const msg = e?.message || "Failed to retry broadcast";
        const status = /not connected/i.test(msg) ? 503 : /Daily limit|daily limit|Too many/i.test(msg) ? 400 : 500;
        if (status === 500) console.error("Broadcast retry error", e);
        return NextResponse.json({ status: false, message: msg, error: msg }, { status });
    }
}
