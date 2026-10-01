import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser } from "@/lib/api-auth";
import { invalidateAlertSettings, smtpConfigured } from "@/lib/alerts";
import { CONFIGURABLE_MODULES } from "@/lib/modules";
import { normalizeRetentionDays } from "@/lib/media-cleanup";

export async function GET(request: NextRequest) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        // @ts-ignore
        const config = await prisma.systemConfig.findUnique({
            where: { id: "default" }
        });

        const data: any = config || { appName: "WA-AKG", faviconUrl: "/favicon.ico" };
        // Only superadmins see alert credentials; everyone else gets the public fields.
        if (user.role !== "SUPERADMIN") {
            delete data.alertTelegramToken;
            delete data.alertTelegramChatId;
            delete data.alertEmail;
        } else {
            data.smtpConfigured = smtpConfigured();
        }
        return NextResponse.json({ status: true, message: "System config fetched", data });
    } catch (error) {
        return NextResponse.json({ status: false, message: "Failed to fetch settings", error: "Failed to fetch settings" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        // @ts-ignore
        const user = await getAuthenticatedUser(req);
        if (!user || user.role !== "SUPERADMIN") {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { appName, logoUrl, faviconUrl, timezone, enableRegistration } = body;

        // Alert settings — only touched when present in the body (undefined = unchanged)
        const alerts: Record<string, unknown> = {};
        if (body.alertsEnabled !== undefined) alerts.alertsEnabled = Boolean(body.alertsEnabled);
        if (body.alertTelegramToken !== undefined) alerts.alertTelegramToken = String(body.alertTelegramToken || "").trim() || null;
        if (body.alertTelegramChatId !== undefined) alerts.alertTelegramChatId = String(body.alertTelegramChatId || "").trim() || null;
        if (body.alertEmail !== undefined) alerts.alertEmail = String(body.alertEmail || "").trim() || null;
        if (body.alertOnLogout !== undefined) alerts.alertOnLogout = Boolean(body.alertOnLogout);
        if (body.alertOnBroadcast !== undefined) alerts.alertOnBroadcast = Boolean(body.alertOnBroadcast);
        if (body.alertOnLimit !== undefined) alerts.alertOnLimit = Boolean(body.alertOnLimit);

        // Sidebar modules: array of hrefs, or null for "all". Only known, configurable hrefs are kept.
        if (body.enabledModules !== undefined) {
            if (body.enabledModules === null) {
                (alerts as Record<string, unknown>).enabledModules = null;
            } else if (Array.isArray(body.enabledModules)) {
                const known = new Set(CONFIGURABLE_MODULES.map(m => m.href));
                const list = Array.from(new Set(body.enabledModules.map(String).filter((h: string) => known.has(h))));
                if (!list.includes("/dashboard")) list.unshift("/dashboard"); // home is always available
                (alerts as Record<string, unknown>).enabledModules = list;
            }
        }

        const general: Record<string, unknown> = {};
        if (body.mediaRetentionDays !== undefined) general.mediaRetentionDays = normalizeRetentionDays(body.mediaRetentionDays);
        if (appName !== undefined) general.appName = appName;
        if (logoUrl !== undefined) general.logoUrl = logoUrl;
        if (faviconUrl !== undefined) general.faviconUrl = faviconUrl;
        if (timezone !== undefined) general.timezone = timezone;
        if (enableRegistration !== undefined) general.enableRegistration = Boolean(enableRegistration);

        // @ts-ignore
        const config = await prisma.systemConfig.upsert({
            where: { id: "default" },
            update: { ...general, ...alerts },
            create: { id: "default", appName: appName || "WABA", logoUrl: logoUrl || "", faviconUrl: faviconUrl || "/favicon.ico", timezone: timezone || "Asia/Kolkata", enableRegistration: enableRegistration ?? true, ...alerts }
        });
        invalidateAlertSettings();

        return NextResponse.json({ status: true, message: "System settings updated", data: { ...config, smtpConfigured: smtpConfigured() } });
    } catch (error) {
        return NextResponse.json({ status: false, message: "Failed to update settings", error: "Failed to update settings" }, { status: 500 });
    }
}
