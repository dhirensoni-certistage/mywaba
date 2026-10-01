import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { cancelBroadcast, isBroadcastActive } from "@/modules/whatsapp/broadcast";

/**
 * POST /api/messages/:sessionId/broadcast/:broadcastId/cancel
 * Stops a running broadcast. Remaining recipients are marked as failed ("Cancelled by user").
 */
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

        const log = await prisma.broadcastLog.findFirst({
            where: { id: broadcastId, sessionId },
            select: { id: true, status: true }
        });
        if (!log) {
            return NextResponse.json({ status: false, message: "Broadcast not found", error: "Broadcast not found" }, { status: 404 });
        }

        if (log.status !== "running") {
            return NextResponse.json({ status: false, message: `Broadcast is already ${log.status}`, error: `Broadcast is already ${log.status}` }, { status: 409 });
        }

        if (!isBroadcastActive(broadcastId)) {
            // Marked running in DB but no worker holds it (e.g. server restarted). Close it out.
            const now = new Date();
            await prisma.$transaction([
                prisma.broadcastRecipient.updateMany({
                    where: { broadcastLogId: broadcastId, status: "pending" },
                    data: { status: "failed", error: "Cancelled by user" }
                }),
                prisma.broadcastLog.update({
                    where: { id: broadcastId },
                    data: { status: "cancelled", error: "Cancelled by user", completedAt: now }
                })
            ]);
            return NextResponse.json({ status: true, message: "Broadcast cancelled" });
        }

        cancelBroadcast(broadcastId);
        return NextResponse.json({ status: true, message: "Cancellation requested. The broadcast will stop after the current message." });
    } catch (e) {
        console.error("Broadcast cancel error", e);
        return NextResponse.json({ status: false, message: "Failed to cancel broadcast", error: "Failed to cancel broadcast" }, { status: 500 });
    }
}
