import { NextResponse, NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/api-auth";
import { sendAlert, invalidateAlertSettings, smtpConfigured } from "@/lib/alerts";

/** POST /api/settings/alerts/test — sends a test alert on every configured channel (SUPERADMIN). */
export async function POST(request: NextRequest) {
    const user = await getAuthenticatedUser(request);
    if (!user || user.role !== "SUPERADMIN") {
        return NextResponse.json({ status: false, message: "Forbidden - Superadmin only", error: "Forbidden" }, { status: 403 });
    }
    invalidateAlertSettings();
    const result = await sendAlert({
        kind: "test",
        title: "Test alert",
        message: `This is a test from the WhatsApp gateway. Alerts are working.\nSent by ${user.email} at ${new Date().toLocaleString("en-IN", { timeZone: process.env.TZ || "Asia/Kolkata" })}.`
    });
    const attempted = Object.keys(result).filter(k => k !== "skipped");
    if (attempted.length === 0) {
        return NextResponse.json({
            status: false,
            message: smtpConfigured()
                ? "No channel configured. Add a Telegram bot token + chat id, or an alert email."
                : "No channel configured. Add a Telegram bot token + chat id, or an alert email (email also needs SMTP_HOST / SMTP_USER / SMTP_PASS in .env)."
        }, { status: 400 });
    }
    return NextResponse.json({ status: true, message: "Test alert sent", data: result });
}
