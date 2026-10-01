import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, forbidStaff } from "@/lib/api-auth";
import { prepareRecipients, type RecipientInput } from "@/modules/whatsapp/broadcast";
import { loadList, MAX_LIST_MEMBERS } from "@/lib/campaign-schemas";

/** POST /api/contact-lists/:id/members { recipients: [...] } — add numbers / Excel rows (duplicates skipped). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const denied = forbidStaff(user, "manage contact lists");
    if (denied) return denied;
    const { id } = await params;
    const r = await loadList(user, id);
    if (r.error) return r.error;
    const parsed = z.object({ recipients: z.array(z.any()).min(1).max(MAX_LIST_MEMBERS) }).safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ status: false, message: "recipients[] required", error: "Validation failed" }, { status: 400 });
    const prepared = prepareRecipients(parsed.data.recipients as RecipientInput[]);
    const existing = await prisma.contactListMember.count({ where: { listId: id } });
    if (existing + prepared.recipients.length > MAX_LIST_MEMBERS) return NextResponse.json({ status: false, message: `A list can hold at most ${MAX_LIST_MEMBERS} members` }, { status: 400 });
    const res = await prisma.contactListMember.createMany({
        data: prepared.recipients.map(m => ({ listId: id, jid: m.jid, name: m.vars.name ?? null, vars: Object.keys(m.vars).length ? (m.vars as any) : undefined })),
        skipDuplicates: true
    });
    // Refresh names/vars of members that already existed (createMany skipped them).
    const added = res.count;
    const duplicates = prepared.recipients.length - added;
    if (duplicates > 0) {
        for (const m of prepared.recipients) {
            if (!m.vars.name && Object.keys(m.vars).length === 0) continue;
            await prisma.contactListMember.updateMany({ where: { listId: id, jid: m.jid }, data: { ...(m.vars.name ? { name: m.vars.name } : {}), ...(Object.keys(m.vars).length ? { vars: m.vars as any } : {}) } }).catch(() => {});
        }
    }
    await prisma.contactList.update({ where: { id }, data: { updatedAt: new Date() } }).catch(() => {});
    return NextResponse.json({ status: true, message: `${added} added${duplicates ? `, ${duplicates} already in the list` : ""}${prepared.invalid.length ? `, ${prepared.invalid.length} invalid skipped` : ""}`, data: { added, duplicates, invalid: prepared.invalid } });
}

/** DELETE /api/contact-lists/:id/members { jids: [...] } or { all: true } */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const denied = forbidStaff(user, "manage contact lists");
    if (denied) return denied;
    const { id } = await params;
    const r = await loadList(user, id);
    if (r.error) return r.error;
    const body = await request.json().catch(() => ({}));
    const where = body?.all === true ? { listId: id } : { listId: id, jid: { in: (Array.isArray(body?.jids) ? body.jids : []).map(String) } };
    if (body?.all !== true && where.jid!.in.length === 0) return NextResponse.json({ status: false, message: "jids[] or all:true required" }, { status: 400 });
    const res = await prisma.contactListMember.deleteMany({ where });
    return NextResponse.json({ status: true, message: `${res.count} removed`, data: { removed: res.count } });
}
