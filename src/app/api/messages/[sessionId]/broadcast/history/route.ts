import { prisma } from "@/lib/prisma";
import { NextResponse, NextRequest } from "next/server";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized" }, { status: 401 });
        }

        const { sessionId } = await params;

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden" }, { status: 403 });
        }

        const { searchParams } = new URL(request.url);
        const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);
        const offset = parseInt(searchParams.get("offset") || "0");

        const [logs, total] = await Promise.all([
            prisma.broadcastLog.findMany({
                where: { sessionId },
                orderBy: { startedAt: "desc" },
                take: limit,
                skip: offset,
                include: {
                    _count: { select: { recipients: true } }
                }
            }),
            prisma.broadcastLog.count({ where: { sessionId } })
        ]);

        // Engagement counters per broadcast (one grouped query instead of N)
        const ids = logs.map(l => l.id);
        const engagement = new Map<string, { replied: number; delivered: number; read: number }>();
        if (ids.length > 0) {
            const rows = await prisma.broadcastRecipient.groupBy({
                by: ["broadcastLogId", "deliveryStatus"],
                where: { broadcastLogId: { in: ids }, status: "sent" },
                _count: { _all: true }
            });
            const replies = await prisma.broadcastRecipient.groupBy({
                by: ["broadcastLogId"],
                where: { broadcastLogId: { in: ids }, repliedAt: { not: null } },
                _count: { _all: true }
            });
            for (const id of ids) engagement.set(id, { replied: 0, delivered: 0, read: 0 });
            for (const r of rows) {
                const e = engagement.get(r.broadcastLogId)!;
                if (r.deliveryStatus === "DELIVERED" || r.deliveryStatus === "READ") e.delivered += r._count._all;
                if (r.deliveryStatus === "READ") e.read += r._count._all;
            }
            for (const r of replies) engagement.get(r.broadcastLogId)!.replied = r._count._all;
        }

        return NextResponse.json({
            status: true,
            data: logs.map(l => ({ ...l, engagement: engagement.get(l.id) || { replied: 0, delivered: 0, read: 0 } })),
            total,
            limit,
            offset
        });
    } catch (e) {
        console.error("Broadcast history error:", e);
        return NextResponse.json({ status: false, message: "Failed to fetch history" }, { status: 500 });
    }
}
