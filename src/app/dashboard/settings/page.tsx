"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { RefreshCw, Save, AlertCircle, Bell, Send } from "lucide-react";
import { toast } from "sonner";

export default function SettingsPage() {
    const router = useRouter();
    const { data: authSession } = useSession();
    const isSuperAdmin = (authSession?.user as any)?.role === "SUPERADMIN";

    const [systemConfig, setSystemConfig] = useState({
        appName: "WABA",
        logoUrl: "",
        timezone: "Asia/Kolkata",
        enableRegistration: true
    });
    const [systemLoading, setSystemLoading] = useState(false);
    const [alerts, setAlerts] = useState({
        alertsEnabled: true,
        alertTelegramToken: "",
        alertTelegramChatId: "",
        alertEmail: "",
        alertOnLogout: true,
        alertOnBroadcast: true,
        alertOnLimit: true,
    });
    const [smtpConfigured, setSmtpConfigured] = useState(false);
    const [alertsLoading, setAlertsLoading] = useState(false);
    const [testingAlert, setTestingAlert] = useState(false);
    const [timezones, setTimezones] = useState<string[]>(["UTC", "Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura"]);

    useEffect(() => {
        try {
            if (typeof Intl !== "undefined" && Intl.supportedValuesOf) {
                const list = Intl.supportedValuesOf("timeZone");
                if (!list.includes("UTC")) {
                    list.push("UTC");
                }
                list.sort();
                setTimezones(list);
            }
        } catch (e) {
            console.error("Failed to load timezones dynamically", e);
        }
    }, []);

    useEffect(() => {
        fetch('/api/settings/system')
            .then(r => { if (!r.ok) throw new Error(); return r.json(); })
            .then(responseData => {
                const data = responseData?.data;
                if (data && !responseData.error) {
                    setSystemConfig({
                        appName: data.appName || "WABA",
                        logoUrl: data.logoUrl || "",
                        // @ts-ignore
                        faviconUrl: data.faviconUrl || "/favicon.ico",
                        timezone: data.timezone || "Asia/Jakarta",
                        enableRegistration: data.enableRegistration !== undefined ? data.enableRegistration : true
                    });
                    setAlerts({
                        alertsEnabled: data.alertsEnabled ?? true,
                        alertTelegramToken: data.alertTelegramToken || "",
                        alertTelegramChatId: data.alertTelegramChatId || "",
                        alertEmail: data.alertEmail || "",
                        alertOnLogout: data.alertOnLogout ?? true,
                        alertOnBroadcast: data.alertOnBroadcast ?? true,
                        alertOnLimit: data.alertOnLimit ?? true,
                    });
                    setSmtpConfigured(Boolean(data.smtpConfigured));
                }
            })
            .catch(() => { });
    }, []);

    const handleSaveAlerts = async () => {
        setAlertsLoading(true);
        try {
            const res = await fetch('/api/settings/system', {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(alerts)
            });
            if (res.ok) toast.success("Alert settings saved");
            else toast.error("Failed to save alert settings");
        } catch {
            toast.error("Failed to save alert settings");
        } finally {
            setAlertsLoading(false);
        }
    };

    const handleTestAlert = async () => {
        setTestingAlert(true);
        try {
            // Save first so the test uses what is on screen
            await fetch('/api/settings/system', { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(alerts) });
            const res = await fetch('/api/settings/alerts/test', { method: "POST" });
            const data = await res.json();
            if (res.ok && data.status) {
                const r = data.data || {};
                const parts = [
                    r.telegram !== undefined ? `Telegram: ${r.telegram ? "sent" : "failed"}` : null,
                    r.email !== undefined ? `Email: ${r.email ? "sent" : "failed"}` : null,
                ].filter(Boolean);
                toast.success(`Test alert — ${parts.join(", ")}`);
            } else {
                toast.error(data.message || "Test failed");
            }
        } catch {
            toast.error("Test failed");
        } finally {
            setTestingAlert(false);
        }
    };

    const handleSaveSystem = async () => {
        setSystemLoading(true);
        try {
            const res = await fetch('/api/settings/system', {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(systemConfig)
            });

            if (res.ok) {
                toast.success("System settings updated successfully!");
                if (typeof window !== "undefined") {
                    window.dispatchEvent(new CustomEvent("system-settings-updated", { detail: systemConfig }));
                }
                if (typeof document !== "undefined" && systemConfig.appName) {
                    document.title = `${systemConfig.appName} | Premium WhatsApp Gateway`;
                }
                router.refresh();
            } else {
                toast.error("Failed to update system settings");
            }
        } catch (e) {
            console.error(e);
            toast.error("Error saving system settings");
        } finally {
            setSystemLoading(false);
        }
    };

    const inputClass = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl sm:text-3xl font-bold tracking-tight">Settings</h2>
                <p className="text-muted-foreground text-sm mt-1">Global system configuration. Only SuperAdmins can make changes.</p>
            </div>

            {!isSuperAdmin && (
                <Card className="border-yellow-200 bg-yellow-50">
                    <CardContent className="pt-6">
                        <div className="flex items-start gap-3">
                            <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5" />
                            <div>
                                <p className="text-sm font-medium text-yellow-900">View Only Mode</p>
                                <p className="text-xs text-yellow-700 mt-1">
                                    Only Superadmins can modify system settings. You can view current settings but cannot make changes.
                                </p>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* System Configuration (Global) */}
            <Card className="border-primary/20 bg-primary/5">
                <CardHeader>
                    <CardTitle className="text-xl">App Configuration</CardTitle>
                    <CardDescription>Global settings for the application branding and access control.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid sm:grid-cols-2 gap-4">
                        <div className="grid gap-2">
                            <Label>Application Name</Label>
                            <input
                                className={inputClass}
                                placeholder="WABA"
                                value={systemConfig.appName}
                                onChange={(e) => setSystemConfig(prev => ({ ...prev, appName: e.target.value }))}
                                disabled={!isSuperAdmin}
                            />
                            <p className="text-xs text-muted-foreground">Changes the name in the sidebar and browser title.</p>
                        </div>

                        <div className="grid gap-2">
                            <Label>Timezone</Label>
                            <select
                                className={inputClass}
                                value={systemConfig.timezone}
                                onChange={(e) => setSystemConfig(prev => ({ ...prev, timezone: e.target.value }))}
                                disabled={!isSuperAdmin}
                            >
                                {timezones.map((tz) => (
                                    <option key={tz} value={tz}>
                                        {tz}
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-muted-foreground">Scheduler will use this timezone.</p>
                        </div>
                    </div>

                    <div className="grid sm:grid-cols-2 gap-4">
                        <div className="grid gap-2">
                            <Label>Logo URL</Label>
                            <input
                                className={inputClass}
                                placeholder="https://example.com/logo.png"
                                value={systemConfig.logoUrl}
                                onChange={(e) => setSystemConfig(prev => ({ ...prev, logoUrl: e.target.value }))}
                                disabled={!isSuperAdmin}
                            />
                            <p className="text-xs text-muted-foreground">URL for the main dashboard logo.</p>
                        </div>
                        <div className="grid gap-2">
                            <Label>Favicon URL</Label>
                            <input
                                className={inputClass}
                                placeholder="/favicon.ico"
                                value={(systemConfig as any).faviconUrl || ""}
                                onChange={(e) => setSystemConfig(prev => ({ ...prev, faviconUrl: e.target.value }))}
                                disabled={!isSuperAdmin}
                            />
                            <p className="text-xs text-muted-foreground">URL for the browser tab icon.</p>
                        </div>
                    </div>

                    <div className="flex items-center justify-between space-x-2 pt-2 border-t border-border/50">
                        <Label htmlFor="enable-registration" className="flex flex-col space-y-1">
                            <span>Enable User Registration</span>
                            <span className="font-normal text-xs text-muted-foreground">Allow new users to sign up for accounts. Turn off to keep the platform private.</span>
                        </Label>
                        <Switch
                            id="enable-registration"
                            checked={systemConfig.enableRegistration}
                            onCheckedChange={c => setSystemConfig(prev => ({ ...prev, enableRegistration: c }))}
                            disabled={!isSuperAdmin}
                        />
                    </div>

                    <div className="pt-2">
                        <Button onClick={handleSaveSystem} disabled={systemLoading || !isSuperAdmin}>
                            {systemLoading ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
                            Save Configuration
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* Alerts */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2"><Bell className="h-5 w-5" /> Alerts (Telegram / Email)</CardTitle>
                    <CardDescription>
                        Get notified outside the dashboard when a WhatsApp session is logged out or auto-stopped, when a broadcast stops or has failures, and when a number has used 80% of its daily limit.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="flex items-center justify-between border p-3 rounded-lg">
                        <Label htmlFor="alerts-enabled" className="flex flex-col space-y-1">
                            <span className="font-semibold">Enable alerts</span>
                            <span className="font-normal text-xs text-muted-foreground">Master switch for all channels below. Dashboard notifications are always created.</span>
                        </Label>
                        <Switch id="alerts-enabled" checked={alerts.alertsEnabled} disabled={!isSuperAdmin}
                            onCheckedChange={c => setAlerts(prev => ({ ...prev, alertsEnabled: c }))} />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label>Telegram bot token</Label>
                            <input className={inputClass} type="password" placeholder="123456789:AAH..." value={alerts.alertTelegramToken} disabled={!isSuperAdmin}
                                onChange={e => setAlerts(prev => ({ ...prev, alertTelegramToken: e.target.value }))} />
                            <p className="text-xs text-muted-foreground">Create a bot with @BotFather in Telegram and paste its token.</p>
                        </div>
                        <div className="space-y-2">
                            <Label>Telegram chat id</Label>
                            <input className={inputClass} placeholder="-1001234567890 or 987654321" value={alerts.alertTelegramChatId} disabled={!isSuperAdmin}
                                onChange={e => setAlerts(prev => ({ ...prev, alertTelegramChatId: e.target.value }))} />
                            <p className="text-xs text-muted-foreground">Send any message to the bot (or add it to a group), then open <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> to read the chat id.</p>
                        </div>
                        <div className="space-y-2 sm:col-span-2">
                            <Label>Alert email(s)</Label>
                            <input className={inputClass} placeholder="you@company.com, ops@company.com" value={alerts.alertEmail} disabled={!isSuperAdmin}
                                onChange={e => setAlerts(prev => ({ ...prev, alertEmail: e.target.value }))} />
                            <p className={`text-xs ${smtpConfigured ? "text-muted-foreground" : "text-yellow-600"}`}>
                                {smtpConfigured
                                    ? "SMTP is configured on the server."
                                    : "Email needs SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (and optional SMTP_FROM) in the server .env — not set yet. Telegram works without any server change."}
                            </p>
                        </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="flex items-center justify-between border p-3 rounded-lg">
                            <Label htmlFor="al-logout" className="text-sm">Session logout / stop</Label>
                            <Switch id="al-logout" checked={alerts.alertOnLogout} disabled={!isSuperAdmin} onCheckedChange={c => setAlerts(prev => ({ ...prev, alertOnLogout: c }))} />
                        </div>
                        <div className="flex items-center justify-between border p-3 rounded-lg">
                            <Label htmlFor="al-broadcast" className="text-sm">Broadcast failures</Label>
                            <Switch id="al-broadcast" checked={alerts.alertOnBroadcast} disabled={!isSuperAdmin} onCheckedChange={c => setAlerts(prev => ({ ...prev, alertOnBroadcast: c }))} />
                        </div>
                        <div className="flex items-center justify-between border p-3 rounded-lg">
                            <Label htmlFor="al-limit" className="text-sm">Daily limit at 80%</Label>
                            <Switch id="al-limit" checked={alerts.alertOnLimit} disabled={!isSuperAdmin} onCheckedChange={c => setAlerts(prev => ({ ...prev, alertOnLimit: c }))} />
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <Button onClick={handleSaveAlerts} disabled={alertsLoading || !isSuperAdmin}>
                            {alertsLoading ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                            Save Alert Settings
                        </Button>
                        <Button variant="outline" onClick={handleTestAlert} disabled={testingAlert || !isSuperAdmin}>
                            {testingAlert ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                            Send Test Alert
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* System Updates */}
            <Card>
                <CardHeader>
                    <CardTitle>System Updates</CardTitle>
                    <CardDescription>Check for the latest version from GitHub.</CardDescription>
                </CardHeader>
                <CardContent>
                    <Button
                        variant="outline"
                        className="w-full"
                        onClick={async () => {
                            setSystemLoading(true);
                            try {
                                const res = await fetch("/api/system/check-updates", { method: "POST" });
                                const data = await res.json();
                                if (data.status) {
                                    toast.success(data.message || "Check complete!");
                                } else {
                                    toast.error(data.message || "Failed to check updates");
                                }
                            } catch (e) {
                                toast.error("Error checking updates");
                            } finally {
                                setSystemLoading(false);
                            }
                        }}
                        disabled={systemLoading}
                    >
                        <RefreshCw className={`mr-2 h-4 w-4 ${systemLoading ? 'animate-spin' : ''}`} />
                        Check for Updates
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
