import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, forbidStaff } from "@/lib/api-auth";
import { resolveScopeUserId } from "@/lib/campaign-scope";
import { prepareRecipients, type RecipientInput } from "@/modules/whatsapp/broadcast";
import { MAX_LIST_MEMBERS } from "@/lib/campaign-schemas";


/** GET /api/contact-lists?sessionId=… — lists of the owner with member counts. */
export async function GET(request: NextRequest) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const ownerId = await resolveScopeUserId(user, request.nextUrl.searchParams.get("sessionId"));
    if (!ownerId) return NextResponse.json({ status: true, message: "No lists", data: [] });
    const lists = await prisma.contactList.findMany({
        where: { userId: ownerId },
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { members: true, campaigns: true } } }
    });
    return NextResponse.json({ status: true, message: "Lists fetched", data: lists.map(l => ({ id: l.id, name: l.name, description: l.description, members: l._count.members, campaigns: l._count.campaigns, createdAt: l.createdAt, updatedAt: l.updatedAt })) });
}

const createSchema = z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional().nullable(),
    /** Optional initial members: numbers, or { number, name, vars } objects (Excel rows). */
    recipients: z.array(z.any()).max(MAX_LIST_MEMBERS).optional()
});

/** POST /api/contact-lists — create a list (owner / superadmin), optionally with members. */
export async function POST(request: NextRequest) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const denied = forbidStaff(user, "manage contact lists");
    if (denied) return denied;
    const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ status: false, message: parsed.error.issues[0]?.message || "Invalid list", error: "Validation failed" }, { status: 400 });
    const { name, description, recipients } = parsed.data;
    const prepared = prepareRecipients((recipients || []) as RecipientInput[]);
    const list = await prisma.contactList.create({ data: { userId: user.id, name, description: description || null } });
    if (prepared.recipients.length > 0) {
        await prisma.contactListMember.createMany({
            data: prepared.recipients.map(r => ({ listId: list.id, jid: r.jid, name: r.vars.name ?? null, vars: Object.keys(r.vars).length ? (r.vars as any) : undefined })),
            skipDuplicates: true
        });
    }
    return NextResponse.json({ status: true, message: `List created${prepared.recipients.length ? ` with ${prepared.recipients.length} member(s)` : ""}`, data: { id: list.id, name: list.name, members: prepared.recipients.length, invalid: prepared.invalid } });
}
