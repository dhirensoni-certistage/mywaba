import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser, forbidStaff } from "@/lib/api-auth";
import { resolveScopeUserId } from "@/lib/campaign-scope";
import { sanitizeButtons } from "@/modules/whatsapp/interactive";
import { templateSchema } from "@/lib/campaign-schemas";

/** GET /api/templates?sessionId=… — templates of the owner (staff: owner of that session). */
export async function GET(request: NextRequest) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const ownerId = await resolveScopeUserId(user, request.nextUrl.searchParams.get("sessionId"));
    if (!ownerId) return NextResponse.json({ status: true, message: "No templates", data: [] });
    const data = await prisma.messageTemplate.findMany({ where: { userId: ownerId }, orderBy: [{ usageCount: "desc" }, { updatedAt: "desc" }] });
    return NextResponse.json({ status: true, message: "Templates fetched", data });
}

/** POST /api/templates — create (owner / superadmin). */
export async function POST(request: NextRequest) {
    const user = await getAuthenticatedUser(request);
    if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
    const denied = forbidStaff(user, "manage templates");
    if (denied) return denied;
    const parsed = templateSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ status: false, message: parsed.error.issues[0]?.message || "Invalid template", error: "Validation failed" }, { status: 400 });
    const d = parsed.data;
    const buttons = sanitizeButtons(d.buttons || []);
    const data = await prisma.messageTemplate.create({
        data: {
            userId: user.id, name: d.name, body: d.body, mediaUrl: d.mediaUrl?.trim() || null,
            mediaType: d.mediaUrl?.trim() ? (d.mediaType || "image") : null,
            buttons: buttons.length ? (buttons as any) : undefined, footer: buttons.length ? (d.footer?.trim() || null) : null,
            buttonMode: buttons.length ? (d.buttonMode === "interactive" ? "interactive" : "text") : null
        }
    });
    return NextResponse.json({ status: true, message: "Template saved", data });
}
