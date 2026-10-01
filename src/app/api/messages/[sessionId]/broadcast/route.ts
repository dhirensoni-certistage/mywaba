import { NextResponse, NextRequest } from "next/server";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { startBroadcast, getBroadcastHealth, BROADCAST_LIMITS } from "@/modules/whatsapp/broadcast";
import { z } from "zod";

const broadcastBodySchema = z.object({
    recipients: z.array(z.string()).min(1, "At least one recipient is required"),
    message: z.string().optional().default(""),
    mediaUrl: z.string().optional().nullable(),
    mediaType: z.string().optional().nullable(),
    /** Delay between messages in ms. Clamped server-side to a safe minimum. */
    delay: z.number().optional(),
    /** Messages per batch before a long cooldown. */
    batchSize: z.number().optional(),
    /** Cooldown between batches in ms. */
    batchPauseMs: z.number().optional(),
    simulateTyping: z.boolean().optional(),
    validateNumbers: z.boolean().optional(),
    shuffle: z.boolean().optional()
}).refine(data => data.message?.trim() || data.mediaUrl?.trim(), {
    message: "Either message or mediaUrl must be provided"
});

/**
 * Returns the server-side safety limits plus this session's number health
 * (sent in last 24h vs daily limit, quiet hours, opt-outs) so the dashboard can mirror them.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    const user = await getAuthenticatedUser(request);
    if (!user) {
        return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    }
    const { sessionId } = await params;
    const canAccess = await canAccessSession(user.id, user.role, sessionId);
    if (!canAccess) {
        return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });
    }
    try {
        const health = await getBroadcastHealth(sessionId);
        return NextResponse.json({
            status: true,
            data: {
                limits: BROADCAST_LIMITS,
                health: { ...health, remaining: Number.isFinite(health.remaining) ? health.remaining : null }
            }
        });
    } catch (e) {
        console.error("Broadcast health error", e);
        return NextResponse.json({ status: false, message: "Failed to load broadcast health" }, { status: 500 });
    }
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const { sessionId } = await params;
        const body = await request.json();

        const parseResult = broadcastBodySchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json({ status: false, message: "Invalid request", error: parseResult.error.flatten() }, { status: 400 });
        }

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });
        }

        const { recipients, message, mediaUrl, mediaType, delay, batchSize, batchPauseMs, simulateTyping, validateNumbers, shuffle } = parseResult.data;

        const result = await startBroadcast({
            sessionId,
            recipients,
            message,
            mediaUrl,
            mediaType,
            delay,
            batchSize,
            batchPauseMs,
            simulateTyping,
            validateNumbers,
            shuffle
        });

        return NextResponse.json({
            status: true,
            message: "Broadcast started",
            data: {
                broadcastId: result.broadcastId,
                total: result.total,
                invalidRecipients: result.invalid
            }
        });
    } catch (e: any) {
        const msg = e?.message || "Failed to start broadcast";
        const status = /not connected|Session not ready/i.test(msg) ? 503
            : /No valid recipients|Too many recipients|Failed to fetch media|Daily limit|daily limit/i.test(msg) ? 400
            : 500;
        if (status === 500) console.error("Broadcast error", e);
        return NextResponse.json({ status: false, message: msg, error: msg }, { status });
    }
}
