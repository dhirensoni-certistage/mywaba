import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, canAccessSession, getAccessibleSessionIds } from "@/lib/api-auth";
import { canReadOwnerResource } from "@/lib/campaign-scope";
import { campaignPayloadSchema } from "@/lib/campaign-schemas";
import { prepareRecipients, BROADCAST_LIMITS, type RecipientInput } from "@/modules/whatsapp/broadcast";
import { cronForRepeat, describeCron, nextRunAfter, validateCron, type Repeat } from "@/modules/whatsapp/campaigns";
import { getSystemTimezone } from "@/modules/whatsapp/safety";

function present(c: any) {
    return {
        id: c.id, name: c.name, status: c.status,
        sessionId: c.session?.sessionId, sessionName: c.session?.name,
        scheduleAt: c.scheduleAt, nextRunAt: c.nextRunAt, lastRunAt: c.lastRunAt, runCount: c.runCount,
        repeat: describeCron(c.cronExpression, c.timezone), cronExpression: c.cronExpression, timezone: c.timezone,
        listId: c.listId, listName: c.list?.name ?? null,
        recipientCount: c.listId ? (c.list?._count?.members ?? null) : (Array.isArray(c.recipients) ? c.recipients.length : 0),
        payload: c.payload, lastResult: c.lastResult, lastError: c.lastError,
        createdAt: c.createdAt, updatedAt: c.updatedAt
    };
}

/** GET /api/campaigns?sessionId=&status= — campaigns on sessions the user can access. */
export async function GET(request: NextRequest) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const sp = request.nextUrl.searchParams;
    const onlySession = sp.get("sessionId");
    const status = sp.get("status");
    const accessible = await getAccessibleSessionIds(user.id, user.role);
    const waIds = onlySession ? accessible.filter(s => s === onlySession) : accessible;
    if (waIds.length === 0) return NextResponse.json({ status: true, message: "No campaigns", data: [] });
    const campaigns = await prisma.campaign.findMany({
        where: { session: { sessionId: { in: waIds } }, ...(status ? { status } : {}) },
        include: { session: { select: { sessionId: true, name: true } }, list: { select: { name: true, _count: { select: { members: true } } } } },
        orderBy: [{ nextRunAt: "asc" }, { createdAt: "desc" }],
        take: 200
    });
    return NextResponse.json({ status: true, message: "Campaigns fetched", data: campaigns.map(present) });
}

const createSchema = z.object({
    sessionId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    scheduleAt: z.string().datetime({ offset: true }),
    repeat: z.enum(["none", "daily", "weekly", "monthly"]).optional().default("none"),
    cronExpression: z.string().trim().max(60).optional(),
    timezone: z.string().trim().max(60).optional(),
    listId: z.string().optional().nullable(),
    recipients: z.array(z.any()).max(BROADCAST_LIMITS.MAX_RECIPIENTS * 10).optional(),
    payload: campaignPayloadSchema
}).refine(d => d.listId || (d.recipients && d.recipients.length > 0), { message: "Pick a contact list or provide recipients" })
  .refine(d => d.payload.message?.trim() || d.payload.mediaUrl?.trim(), { message: "The campaign needs a message or media" });

/** POST /api/campaigns — schedule a broadcast (once or recurring). */
export async function POST(request: NextRequest) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ status: false, message: parsed.error.issues[0]?.message || "Invalid campaign", error: "Validation failed" }, { status: 400 });
    const d = parsed.data;

    if (!(await canAccessSession(user.id, user.role, d.sessionId))) return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });
    const session = await prisma.session.findUnique({ where: { sessionId: d.sessionId }, select: { id: true, name: true } });
    if (!session) return NextResponse.json({ status: false, message: "Session not found" }, { status: 404 });

    const scheduleAt = new Date(d.scheduleAt);
    if (Number.isNaN(scheduleAt.getTime())) return NextResponse.json({ status: false, message: "Invalid schedule time" }, { status: 400 });
    if (scheduleAt.getTime() < Date.now() - 60_000) return NextResponse.json({ status: false, message: "The schedule time is in the past" }, { status: 400 });

    const timezone = d.timezone || await getSystemTimezone();
    let cronExpression: string | null = null;
    if (d.cronExpression) {
        if (!validateCron(d.cronExpression)) return NextResponse.json({ status: false, message: "Invalid cron expression" }, { status: 400 });
        cronExpression = d.cronExpression;
    } else {
        cronExpression = cronForRepeat(d.repeat as Repeat, scheduleAt, timezone);
    }

    let recipients: RecipientInput[] | null = null;
    let listId: string | null = null;
    if (d.listId) {
        const list = await prisma.contactList.findUnique({ where: { id: d.listId }, select: { id: true, userId: true, _count: { select: { members: true } } } });
        if (!list || !(await canReadOwnerResource(user, list.userId))) return NextResponse.json({ status: false, message: "Contact list not found" }, { status: 404 });
        if (list._count.members === 0) return NextResponse.json({ status: false, message: "That contact list is empty" }, { status: 400 });
        listId = list.id;
    } else {
        const prepared = prepareRecipients((d.recipients || []) as RecipientInput[]);
        if (prepared.recipients.length === 0) return NextResponse.json({ status: false, message: "No valid recipients" }, { status: 400 });
        const numbers = 1 + new Set((d.payload.sessionIds || []).filter(s => s !== d.sessionId)).size;
        if (prepared.recipients.length > BROADCAST_LIMITS.MAX_RECIPIENTS * numbers) return NextResponse.json({ status: false, message: `Too many recipients: max ${BROADCAST_LIMITS.MAX_RECIPIENTS} per number per run` }, { status: 400 });
        recipients = prepared.recipients.map(r => ({ jid: r.jid, vars: Object.keys(r.vars).length ? r.vars : undefined }));
    }

    const campaign = await prisma.campaign.create({
        data: {
            userId: user.id, sessionId: session.id, name: d.name, status: "SCHEDULED",
            scheduleAt, cronExpression, timezone, nextRunAt: scheduleAt,
            listId, recipients: recipients ? (recipients as any) : undefined,
            payload: d.payload as any
        },
        include: { session: { select: { sessionId: true, name: true } }, list: { select: { name: true, _count: { select: { members: true } } } } }
    });
    return NextResponse.json({ status: true, message: `Campaign scheduled for ${scheduleAt.toLocaleString("en-IN", { timeZone: timezone })}${cronExpression ? ` and then ${describeCron(cronExpression, timezone)}` : ""}`, data: present(campaign) });
}
