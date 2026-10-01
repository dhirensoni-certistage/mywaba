import { NextResponse, NextRequest } from "next/server";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { startBroadcast, getBroadcastHealth, BROADCAST_LIMITS, type RecipientInput } from "@/modules/whatsapp/broadcast";
import { waManager } from "@/modules/whatsapp/manager";
import { z } from "zod";

const recipientSchema = z.union([
    z.string(),
    z.object({
        number: z.string().optional(),
        phone: z.string().optional(),
        jid: z.string().optional(),
        name: z.string().nullable().optional(),
        vars: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional()
    }).passthrough()
]);

const buttonSchema = z.object({
    type: z.enum(["reply", "url", "call"]).default("reply"),
    text: z.string().min(1).max(25),
    url: z.string().optional(),
    phone: z.string().optional()
});

const broadcastBodySchema = z.object({
    recipients: z.array(recipientSchema).min(1, "At least one recipient is required"),
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
    shuffle: z.boolean().optional(),
    /** Spread the run evenly over N hours (overrides delay/batch settings). */
    spreadHours: z.number().min(0).max(72).optional(),
    /** Extra connected sessions the user can access; recipients are split round-robin across all of them. */
    sessionIds: z.array(z.string()).optional(),
    /** Up to 3 interactive buttons (BETA). */
    buttons: z.array(buttonSchema).max(3).optional(),
    footer: z.string().max(60).optional(),
    /** "interactive" (native-flow buttons, default) or "text" (buttons appended as plain lines — shows everywhere). */
    buttonMode: z.enum(["interactive", "text"]).optional()
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

        const { recipients, message, mediaUrl, mediaType, delay, batchSize, batchPauseMs, simulateTyping, validateNumbers, shuffle, spreadHours, sessionIds, buttons, footer, buttonMode } = parseResult.data;

        // ---- Multi-number rotation: split the list across every connected session the user may use ----
        const targetSessions: string[] = [sessionId];
        const rejectedSessions: { sessionId: string; reason: string }[] = [];
        for (const extra of Array.from(new Set(sessionIds || []))) {
            if (extra === sessionId) continue;
            const ok = await canAccessSession(user.id, user.role, extra);
            if (!ok) { rejectedSessions.push({ sessionId: extra, reason: "no access" }); continue; }
            const inst = waManager.getInstance(extra);
            if (!inst?.socket || inst.status !== "CONNECTED") { rejectedSessions.push({ sessionId: extra, reason: "not connected" }); continue; }
            targetSessions.push(extra);
        }

        const buckets: RecipientInput[][] = targetSessions.map(() => []);
        (recipients as RecipientInput[]).forEach((r, i) => { buckets[i % targetSessions.length].push(r); });

        const common = { message, mediaUrl, mediaType, delay, batchSize, batchPauseMs, simulateTyping, validateNumbers, shuffle, spreadHours, buttons, footer, buttonMode };
        const started: { sessionId: string; broadcastId: string; total: number; delayMs: number }[] = [];
        const invalid: string[] = [];
        const failures: { sessionId: string; error: string }[] = [];

        for (let i = 0; i < targetSessions.length; i++) {
            if (buckets[i].length === 0) continue;
            try {
                const result = await startBroadcast({ sessionId: targetSessions[i], recipients: buckets[i], ...common });
                started.push({ sessionId: targetSessions[i], broadcastId: result.broadcastId, total: result.total, delayMs: result.delayMs });
                invalid.push(...result.invalid);
            } catch (e: any) {
                // The primary session failing is a hard error; an extra session failing just means its share is not sent.
                if (i === 0) throw e;
                failures.push({ sessionId: targetSessions[i], error: e?.message || "Failed to start" });
            }
        }

        return NextResponse.json({
            status: true,
            message: started.length > 1 ? `Broadcast started on ${started.length} numbers` : "Broadcast started",
            data: {
                // legacy single-broadcast fields (first/primary run)
                broadcastId: started[0]?.broadcastId,
                total: started.reduce((n, b) => n + b.total, 0),
                invalidRecipients: Array.from(new Set(invalid)),
                broadcasts: started,
                rejectedSessions,
                failures
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
