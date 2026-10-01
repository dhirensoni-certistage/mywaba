
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { batchResolveToPhoneJid } from "@/lib/jid-utils";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(req);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const { sessionId } = await params;
        const { searchParams } = new URL(req.url);
        const page = parseInt(searchParams.get("page") || "1");
        const limitParam = searchParams.get("limit") || "10";
        const isAll = limitParam === "all";
        const limit = isAll ? 0 : parseInt(limitParam) || 10;
        const search = searchParams.get("search") || "";

        // Check if user can access this session
        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
        }

        // Resolve sessionId string to database ID (CUID)
        const sessionData = await prisma.session.findUnique({
            where: { sessionId: sessionId },
            select: { id: true }
        });

        if (!sessionData) {
            return NextResponse.json({ status: false, message: "Session not found", error: "Session not found" }, { status: 404 });
        }

        const where: any = {
            sessionId: sessionData.id,
            // LID-keyed rows (privacy ids, no phone number) are legacy data; new ones are no longer created.
            NOT: { jid: { endsWith: "@lid" } },
        };

        if (search) {
            where.OR = [
                { name: { contains: search } },
                { notify: { contains: search } },
                { verifiedName: { contains: search } },
                { jid: { contains: search } },
                { remoteJidAlt: { contains: search } }
            ];
        }

        const [contacts, total] = await Promise.all([
            prisma.contact.findMany({
                where,
                ...(isAll ? {} : { skip: (page - 1) * limit, take: limit }),
                orderBy: { name: 'asc' },
                include: {
                    _count: {
                        select: { messages: true }
                    }
                }
            }),
            prisma.contact.count({ where })
        ]);

        return NextResponse.json({
            status: true,
            message: "Contacts retrieved successfully",
            data: contacts,
            meta: {
                total,
                page: isAll ? 1 : page,
                limit: isAll ? total : limit,
                totalPages: isAll ? 1 : Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error("Error fetching contacts:", error);
        return NextResponse.json({ status: false, message: "Internal Server Error", error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(req);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const { sessionId } = await params;
        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
        }

        const sessionData = await prisma.session.findUnique({
            where: { sessionId: sessionId },
            select: { id: true }
        });

        if (!sessionData) {
            return NextResponse.json({ status: false, message: "Session not found", error: "Session not found" }, { status: 404 });
        }

        const body = await req.json();
        const rawContacts: Array<{ name?: string; phone: string }> = Array.isArray(body.contacts) ? body.contacts : [];

        if (rawContacts.length === 0) {
            return NextResponse.json({ status: false, message: "No contacts provided" }, { status: 400 });
        }

        const upsertPromises = rawContacts.map(async (c) => {
            const rawPhone = String(c.phone || "").trim();
            const cleanPhone = rawPhone.replace(/\D/g, "");
            if (!cleanPhone || cleanPhone.length < 5) return null;

            const jid = `${cleanPhone}@s.whatsapp.net`;
            const contactName = c.name?.trim() || cleanPhone;

            return prisma.contact.upsert({
                where: {
                    sessionId_jid: {
                        sessionId: sessionData.id,
                        jid: jid
                    }
                },
                create: {
                    sessionId: sessionData.id,
                    jid: jid,
                    name: contactName,
                    notify: contactName,
                    remoteJidAlt: cleanPhone
                },
                update: {
                    name: c.name?.trim() ? c.name.trim() : undefined,
                    notify: c.name?.trim() ? c.name.trim() : undefined,
                    remoteJidAlt: cleanPhone
                }
            });
        });

        const results = await Promise.allSettled(upsertPromises);
        const importedCount = results.filter(r => r.status === "fulfilled" && (r as PromiseFulfilledResult<any>).value !== null).length;

        return NextResponse.json({
            status: true,
            message: `Successfully imported ${importedCount} contacts`,
            data: { imported: importedCount, total: rawContacts.length }
        });
    } catch (error: any) {
        console.error("Error importing contacts:", error);
        return NextResponse.json({ status: false, message: error.message || "Failed to import contacts" }, { status: 500 });
    }
}
