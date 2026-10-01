import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, forbidStaff } from "@/lib/api-auth";
import { loadList } from "@/lib/campaign-schemas";

/** GET /api/contact-lists/:id?limit=&offset=&q= — list with members (paged). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    const r = await loadList(user, id);
    if (r.error) return r.error;
    const sp = request.nextUrl.searchParams;
    const limit = Math.min(5000, Math.max(1, parseInt(sp.get("limit") || "500", 10) || 500));
    const offset = Math.max(0, parseInt(sp.get("offset") || "0", 10) || 0);
    const q = (sp.get("q") || "").trim();
    const where = { listId: id, ...(q ? { OR: [{ jid: { contains: q } }, { name: { contains: q } }] } : {}) };
    const [members, total, all] = await Promise.all([
        prisma.contactListMember.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
        prisma.contactListMember.count({ where }),
        prisma.contactListMember.count({ where: { listId: id } })
    ]);
    return NextResponse.json({ status: true, message: "List", data: { ...r.list, members: members.map(m => ({ id: m.id, jid: m.jid, number: m.jid.split("@")[0], name: m.name, vars: m.vars, createdAt: m.createdAt })), total, allMembers: all, limit, offset } });
}

const updateSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(300).optional().nullable() });

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const denied = forbidStaff(user, "manage contact lists");
    if (denied) return denied;
    const { id } = await params;
    const r = await loadList(user, id);
    if (r.error) return r.error;
    const parsed = updateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ status: false, message: "Invalid data", error: "Validation failed" }, { status: 400 });
    const data = await prisma.contactList.update({ where: { id }, data: { ...(parsed.data.name ? { name: parsed.data.name } : {}), ...(parsed.data.description !== undefined ? { description: parsed.data.description || null } : {}) } });
    return NextResponse.json({ status: true, message: "List updated", data });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const denied = forbidStaff(user, "manage contact lists");
    if (denied) return denied;
    const { id } = await params;
    const r = await loadList(user, id);
    if (r.error) return r.error;
    const campaigns = await prisma.campaign.count({ where: { listId: id, status: { in: ["SCHEDULED", "PAUSED", "RUNNING"] } } });
    if (campaigns > 0) return NextResponse.json({ status: false, message: `${campaigns} scheduled campaign(s) still use this list — cancel them first` }, { status: 409 });
    await prisma.contactList.delete({ where: { id } });
    return NextResponse.json({ status: true, message: "List deleted" });
}
