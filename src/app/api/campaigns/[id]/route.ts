import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";
import { nextRunAfter } from "@/modules/whatsapp/campaigns";
import { getSystemTimezone } from "@/modules/whatsapp/safety";

async function load(user: { id: string; role: string }, id: string) {
    const c = await prisma.campaign.findUnique({ where: { id }, include: { session: { select: { sessionId: true, name: true } }, list: { select: { name: true, _count: { select: { members: true } } } } } });
    if (!c) return { error: NextResponse.json({ status: false, message: "Campaign not found" }, { status: 404 }) };
    if (!(await canAccessSession(user.id, user.role, c.session.sessionId))) return { error: NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 }) };
    return { c };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    const r = await load(user, id);
    if (r.error) return r.error;
    return NextResponse.json({ status: true, message: "Campaign", data: r.c });
}

/**
 * PATCH /api/campaigns/:id { action: "pause" | "resume" | "cancel" | "run_now" | "reschedule", scheduleAt? }
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    const r = await load(user, id);
    if (r.error) return r.error;
    const c = r.c!;
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "");
    const now = new Date();
    const tz = c.timezone || await getSystemTimezone();

    if (action === "pause") {
        if (c.status !== "SCHEDULED") return NextResponse.json({ status: false, message: `Cannot pause a ${c.status.toLowerCase()} campaign` }, { status: 409 });
        await prisma.campaign.update({ where: { id }, data: { status: "PAUSED" } });
        return NextResponse.json({ status: true, message: "Campaign paused" });
    }
    if (action === "resume") {
        if (c.status !== "PAUSED") return NextResponse.json({ status: false, message: "Campaign is not paused" }, { status: 409 });
        // Missed occurrences while paused are skipped: resume at the next future time.
        let next = c.nextRunAt && c.nextRunAt > now ? c.nextRunAt : null;
        if (!next && c.cronExpression) next = nextRunAfter(c.cronExpression, tz, now);
        if (!next) return NextResponse.json({ status: false, message: "The scheduled time has passed — use Run now or reschedule" }, { status: 409 });
        await prisma.campaign.update({ where: { id }, data: { status: "SCHEDULED", nextRunAt: next, lastError: null } });
        return NextResponse.json({ status: true, message: `Campaign resumed, next run ${next.toLocaleString("en-IN", { timeZone: tz })}` });
    }
    if (action === "cancel") {
        if (!["SCHEDULED", "PAUSED", "FAILED"].includes(c.status)) return NextResponse.json({ status: false, message: `Cannot cancel a ${c.status.toLowerCase()} campaign` }, { status: 409 });
        await prisma.campaign.update({ where: { id }, data: { status: "CANCELLED", nextRunAt: null } });
        return NextResponse.json({ status: true, message: "Campaign cancelled" });
    }
    if (action === "run_now") {
        if (!["SCHEDULED", "PAUSED", "FAILED", "DONE"].includes(c.status)) return NextResponse.json({ status: false, message: `Cannot start a ${c.status.toLowerCase()} campaign now` }, { status: 409 });
        // The scheduler picks it up within a minute; recurring campaigns keep their rhythm afterwards.
        await prisma.campaign.update({ where: { id }, data: { status: "SCHEDULED", nextRunAt: now, lastError: null } });
        return NextResponse.json({ status: true, message: "Campaign will start within a minute" });
    }
    if (action === "reschedule") {
        const when = new Date(String(body?.scheduleAt || ""));
        if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60_000) return NextResponse.json({ status: false, message: "Invalid or past time" }, { status: 400 });
        if (!["SCHEDULED", "PAUSED", "FAILED", "DONE", "CANCELLED"].includes(c.status)) return NextResponse.json({ status: false, message: "Campaign is running" }, { status: 409 });
        await prisma.campaign.update({ where: { id }, data: { status: "SCHEDULED", scheduleAt: when, nextRunAt: when, lastError: null } });
        return NextResponse.json({ status: true, message: `Rescheduled for ${when.toLocaleString("en-IN", { timeZone: tz })}` });
    }
    return NextResponse.json({ status: false, message: "Unknown action" }, { status: 400 });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    const r = await load(user, id);
    if (r.error) return r.error;
    if (r.c!.status === "RUNNING") return NextResponse.json({ status: false, message: "Campaign is starting right now — try again in a minute" }, { status: 409 });
    await prisma.campaign.delete({ where: { id } });
    return NextResponse.json({ status: true, message: "Campaign deleted" });
}
