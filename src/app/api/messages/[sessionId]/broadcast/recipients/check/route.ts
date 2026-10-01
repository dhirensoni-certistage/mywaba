import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { normalizeRecipient } from "@/modules/whatsapp/broadcast";
import { checkNumbers } from "@/modules/whatsapp/number-check";
import { normalizeJid } from "@/lib/jid-utils";

/**
 * POST /api/messages/:sessionId/broadcast/recipients/check
 * Body: { numbers: string[] } (max 300 per call — the dashboard sends the list in pages)
 *
 * Returns, for every input: { input, number, jid, status: "ok" | "not_on_whatsapp" | "invalid" | "opted_out" }
 * Results are cached per session for 24h, so re-checking is free and the broadcast itself
 * does not look the numbers up again.
 */
export const MAX_PER_CALL = 300;

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
        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });
        }

        const body = await request.json().catch(() => ({}));
        const numbers: unknown = body?.numbers;
        if (!Array.isArray(numbers) || numbers.length === 0) {
            return NextResponse.json({ status: false, message: "numbers (array) is required" }, { status: 400 });
        }
        if (numbers.length > MAX_PER_CALL) {
            return NextResponse.json({ status: false, message: `Maximum ${MAX_PER_CALL} numbers per request` }, { status: 400 });
        }

        const inputs = numbers.map(n => String(n ?? "").trim());
        const normalized = inputs.map(n => normalizeRecipient(n));
        const toCheck = normalized.filter((j): j is string => !!j);

        let checked: Awaited<ReturnType<typeof checkNumbers>> = [];
        try {
            checked = await checkNumbers(sessionId, toCheck);
        } catch (e: any) {
            return NextResponse.json({ status: false, message: e?.message || "Session not connected" }, { status: 503 });
        }
        const byJid = new Map<string, (typeof checked)[number]>();
        toCheck.forEach((j, i) => byJid.set(j, checked[i]));

        // Opted-out contacts
        const session = await prisma.session.findUnique({ where: { sessionId }, select: { id: true } });
        const optedOut = new Set<string>();
        if (session) {
            const rows = await prisma.contact.findMany({
                where: { sessionId: session.id, optedOut: true, jid: { in: toCheck.map(j => normalizeJid(j)) } },
                select: { jid: true }
            });
            rows.forEach(r => optedOut.add(r.jid));
        }

        const results = inputs.map((input, i) => {
            const jid = normalized[i];
            if (!jid) return { input, number: null, jid: null, status: "invalid" as const };
            const r = byJid.get(jid);
            const number = jid.split("@")[0];
            if (optedOut.has(normalizeJid(jid))) return { input, number, jid, status: "opted_out" as const };
            if (r && !r.exists) return { input, number, jid, status: "not_on_whatsapp" as const };
            return { input, number, jid: r?.jid || jid, status: "ok" as const };
        });

        const summary = {
            total: results.length,
            ok: results.filter(r => r.status === "ok").length,
            notOnWhatsApp: results.filter(r => r.status === "not_on_whatsapp").length,
            invalid: results.filter(r => r.status === "invalid").length,
            optedOut: results.filter(r => r.status === "opted_out").length
        };

        return NextResponse.json({ status: true, data: { results, summary } });
    } catch (e: any) {
        console.error("Recipient check error", e);
        return NextResponse.json({ status: false, message: e?.message || "Failed to check numbers" }, { status: 500 });
    }
}
