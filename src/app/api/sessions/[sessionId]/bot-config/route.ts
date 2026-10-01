import { prisma } from "@/lib/prisma";
import { NextResponse, NextRequest } from "next/server";
import { getAuthenticatedUser, canAccessSession, forbidStaff } from "@/lib/api-auth";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    const { sessionId } = await params;

    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
        }

        // @ts-ignore
        const session = await (prisma as any).session.findUnique({
            where: { sessionId },
            select: { id: true, botConfig: true }
        });

        if (!session) {
            return NextResponse.json({ status: false, message: "Session not found", error: "Session not found" }, { status: 404 });
        }

        // Return config or default if null
        session.botConfig = session.botConfig || {
            enabled: true,
            botMode: 'OWNER',
            botAllowedJids: [],
            botBlockedJids: [],
            autoReplyMode: 'ALL',
            autoReplyAllowedJids: [],
            autoReplyBlockedJids: [],
            enableSticker: true,
            enablePing: true,
            enableUptime: true,
            botName: "WA-AKG Bot",
            removeBgApiKey: null,
            enableVideoSticker: true,
            maxStickerDuration: 10,
            prefix: "#",
            antiSpamEnabled: false,
            spamLimit: 5,
            spamInterval: 10,
            spamDelayMin: 1000,
            spamDelayMax: 3000,
            welcomeMessage: null,
            autoRead: false,
            alwaysOnline: false,
            dailyBroadcastLimit: 200,
            quietHoursStart: null,
            quietHoursEnd: null,
            optOutEnabled: true,
            optOutKeywords: null,
            optOutReply: null
        };

        return NextResponse.json({ status: true, message: "Bot config fetched successfully", data: session.botConfig });
    } catch (error) {
        console.error("Get Bot Config Error:", error);
        return NextResponse.json({ status: false, message: "Internal Server Error", error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    const { sessionId } = await params;

    try {
        const user = await getAuthenticatedUser(request);
        if (!user) return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });

        const body = await request.json();

        // Find session DB ID
        const session = await prisma.session.findUnique({
            where: { sessionId },
            select: { id: true }
        });

        if (!session) return NextResponse.json({ status: false, message: "Session not found", error: "Session not found" }, { status: 404 });

        // Broadcast Safety fields — validated/clamped; undefined means "leave unchanged"
        const toHour = (v: unknown) => {
            if (v === undefined) return undefined;
            if (v === null || v === "") return null;
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(0, Math.min(23, Math.round(n))) : null;
        };
        const safetyFields: Record<string, unknown> = {};
        if (body.dailyBroadcastLimit !== undefined) {
            const n = Number(body.dailyBroadcastLimit);
            safetyFields.dailyBroadcastLimit = Number.isFinite(n) ? Math.max(0, Math.min(10000, Math.round(n))) : 200;
        }
        const staffDenied = forbidStaff(user, "change bot settings");
        if (staffDenied) return staffDenied;
        if (body.quietHoursStart !== undefined) safetyFields.quietHoursStart = toHour(body.quietHoursStart);
        if (body.quietHoursEnd !== undefined) safetyFields.quietHoursEnd = toHour(body.quietHoursEnd);
        if (body.optOutEnabled !== undefined) safetyFields.optOutEnabled = Boolean(body.optOutEnabled);
        if (body.optOutKeywords !== undefined) {
            const raw = Array.isArray(body.optOutKeywords)
                ? body.optOutKeywords
                : String(body.optOutKeywords || "").split(",");
            const list = raw.map((k: unknown) => String(k).trim()).filter(Boolean).slice(0, 20);
            safetyFields.optOutKeywords = list.length > 0 ? list : null;
        }
        if (body.optOutReply !== undefined) safetyFields.optOutReply = body.optOutReply ? String(body.optOutReply).slice(0, 1000) : null;

        // Upsert Config
        // @ts-ignore
        const config = await (prisma as any).botConfig.upsert({
            where: { sessionId: session.id },
            create: {
                sessionId: session.id,
                enabled: body.enabled ?? true,
                botMode: body.botMode || 'OWNER',
                botAllowedJids: body.botAllowedJids || [],
                botBlockedJids: body.botBlockedJids || [],
                autoReplyMode: body.autoReplyMode || 'ALL',
                autoReplyAllowedJids: body.autoReplyAllowedJids || [],
                autoReplyBlockedJids: body.autoReplyBlockedJids || [],

                enableSticker: body.enableSticker ?? true,
                enableVideoSticker: body.enableVideoSticker ?? true,
                maxStickerDuration: body.maxStickerDuration || 10,
                enablePing: body.enablePing ?? true,
                enableUptime: body.enableUptime ?? true,
                removeBgApiKey: body.removeBgApiKey || null,
                prefix: body.prefix || "#",
                antiSpamEnabled: body.antiSpamEnabled ?? false,
                spamLimit: body.spamLimit || 5,
                spamInterval: body.spamInterval || 10,
                spamDelayMin: body.spamDelayMin || 1000,
                spamDelayMax: body.spamDelayMax || 3000,
                welcomeMessage: body.welcomeMessage || null,
                autoRead: body.autoRead ?? false,
                alwaysOnline: body.alwaysOnline ?? false,
                ...safetyFields,
            },
            update: {
                botMode: body.botMode,
                botAllowedJids: body.botAllowedJids,
                botBlockedJids: body.botBlockedJids,
                autoReplyMode: body.autoReplyMode,
                autoReplyAllowedJids: body.autoReplyAllowedJids,
                autoReplyBlockedJids: body.autoReplyBlockedJids,
                botName: body.botName,
                enableSticker: body.enableSticker,
                enableVideoSticker: body.enableVideoSticker,
                maxStickerDuration: body.maxStickerDuration,
                enablePing: body.enablePing,
                enableUptime: body.enableUptime,
                removeBgApiKey: body.removeBgApiKey || null,
                prefix: body.prefix,
                antiSpamEnabled: body.antiSpamEnabled,
                spamLimit: body.spamLimit,
                spamInterval: body.spamInterval,
                spamDelayMin: body.spamDelayMin,
                spamDelayMax: body.spamDelayMax,
                welcomeMessage: body.welcomeMessage,
                autoRead: body.autoRead,
                alwaysOnline: body.alwaysOnline,
                ...safetyFields,
            }
        });

        return NextResponse.json({ status: true, message: "Bot config updated successfully", data: config });
    } catch (error) {
        console.error("Update Bot Config Error:", error);
        return NextResponse.json({ status: false, message: "Failed to update config", error: "Failed to update config" }, { status: 500 });
    }
}
