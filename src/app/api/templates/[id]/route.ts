import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, forbidStaff } from "@/lib/api-auth";
import { canReadOwnerResource } from "@/lib/campaign-scope";
import { sanitizeButtons } from "@/modules/whatsapp/interactive";
import { templateSchema } from "@/lib/campaign-schemas";

async function load(user: { id: string; role: string }, id: string) {
    const t = await prisma.messageTemplate.findUnique({ where: { id } });
    if (!t) return { error: NextResponse.json({ status: false, message: "Template not found" }, { status: 404 }) };
    if (!(await canReadOwnerResource(user, t.userId))) return { error: NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 }) };
    return { t };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const { id } = await params;
    const r = await load(user, id);
    if (r.error) return r.error;
    return NextResponse.json({ status: true, message: "Template", data: r.t });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const denied = forbidStaff(user, "manage templates");
    if (denied) return denied;
    const { id } = await params;
    const r = await load(user, id);
    if (r.error) return r.error;
    if (r.t!.userId !== user.id && user.role !== "SUPERADMIN") return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });
    const parsed = templateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ status: false, message: parsed.error.issues[0]?.message || "Invalid template", error: "Validation failed" }, { status: 400 });
    const d = parsed.data;
    const buttons = sanitizeButtons(d.buttons || []);
    const data = await prisma.messageTemplate.update({
        where: { id },
        data: {
            name: d.name, body: d.body, mediaUrl: d.mediaUrl?.trim() || null, mediaType: d.mediaUrl?.trim() ? (d.mediaType || "image") : null,
            buttons: buttons.length ? (buttons as any) : null, footer: buttons.length ? (d.footer?.trim() || null) : null,
            buttonMode: buttons.length ? (d.buttonMode === "interactive" ? "interactive" : "text") : null
        }
    });
    return NextResponse.json({ status: true, message: "Template updated", data });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const denied = forbidStaff(user, "manage templates");
    if (denied) return denied;
    const { id } = await params;
    const r = await load(user, id);
    if (r.error) return r.error;
    if (r.t!.userId !== user.id && user.role !== "SUPERADMIN") return NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 });
    await prisma.messageTemplate.delete({ where: { id } });
    return NextResponse.json({ status: true, message: "Template deleted" });
}
