import { z } from "zod";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canReadOwnerResource } from "@/lib/campaign-scope";

// Shared by the templates / contact-lists / campaigns route handlers. (Route files may only export
// HTTP methods, so anything reused lives here.)

export const MAX_LIST_MEMBERS = 20000;

export const buttonSchema = z.object({
    type: z.enum(["reply", "url", "call"]).default("reply"),
    text: z.string().min(1).max(25),
    url: z.string().optional(),
    phone: z.string().optional()
});

export const templateSchema = z.object({
    name: z.string().trim().min(1).max(80),
    body: z.string().max(4000).default(""),
    mediaUrl: z.string().trim().max(1000).optional().nullable(),
    mediaType: z.enum(["image", "video", "audio", "document"]).optional().nullable(),
    buttons: z.array(buttonSchema).max(3).optional().nullable(),
    footer: z.string().max(60).optional().nullable(),
    buttonMode: z.enum(["interactive", "text"]).optional().nullable()
}).refine(d => d.body.trim() || d.mediaUrl?.trim(), { message: "A template needs a message or a media URL" });

/** The broadcast settings a campaign stores and replays (same fields as POST /broadcast minus recipients). */
export const campaignPayloadSchema = z.object({
    message: z.string().optional().default(""),
    mediaUrl: z.string().optional().nullable(),
    mediaType: z.string().optional().nullable(),
    delay: z.number().optional(),
    batchSize: z.number().optional(),
    batchPauseMs: z.number().optional(),
    simulateTyping: z.boolean().optional(),
    validateNumbers: z.boolean().optional(),
    shuffle: z.boolean().optional(),
    autoVary: z.boolean().optional(),
    spreadHours: z.number().min(0).max(72).optional(),
    sessionIds: z.array(z.string()).optional(),
    buttons: z.array(buttonSchema).max(3).optional(),
    footer: z.string().max(60).optional(),
    buttonMode: z.enum(["interactive", "text"]).optional()
});

export async function loadList(user: { id: string; role: string }, id: string) {
    const list = await prisma.contactList.findUnique({ where: { id } });
    if (!list) return { error: NextResponse.json({ status: false, message: "List not found" }, { status: 404 }) };
    if (!(await canReadOwnerResource(user, list.userId))) return { error: NextResponse.json({ status: false, message: "Forbidden", error: "Forbidden" }, { status: 403 }) };
    return { list };
}
