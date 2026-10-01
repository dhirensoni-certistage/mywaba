"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RefreshCw, Send, CheckCircle2, XCircle, Radio, Clock, AlertTriangle, History, Eye, Calendar, Ban, ShieldCheck, Info, Shuffle, Gauge, MoonStar, UserX, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/dashboard/session-provider";
import { SessionGuard } from "@/components/dashboard/session-guard";
import { useSocket } from "@/components/chat/socket-context";
import { MediaUploadInput } from "@/components/dashboard/media-upload-input";

type BroadcastStatus = "running" | "completed" | "cancelled" | "failed";

interface BroadcastProgress {
    broadcastId: string;
    status: BroadcastStatus;
    total: number;
    sent: number;
    failed: number;
    skipped?: number;
    current?: string | null;
    progress?: number;
    note?: string | null;
    error?: string | null;
    errors?: { jid: string; error: string }[];
    startedAt?: string;
    completedAt?: string;
}

interface BroadcastHealth {
    sentLast24h: number;
    dailyLimit: number;
    remaining: number | null;
    quietHours: { start: number | null; end: number | null; active: boolean; label: string | null };
    optedOutCount: number;
    timezone: string;
    sessionStatus: string;
    lastDisconnectReason: string | null;
}

// Mirrors BROADCAST_LIMITS on the server (src/modules/whatsapp/broadcast.ts)
const LIMITS = {
    MIN_DELAY_MS: 3000,
    DEFAULT_DELAY_MS: 8000,
    MAX_DELAY_MS: 120000,
    DEFAULT_BATCH_SIZE: 20,
    MIN_BATCH_SIZE: 5,
    MAX_BATCH_SIZE: 100,
    DEFAULT_BATCH_PAUSE_MS: 60000,
    MIN_BATCH_PAUSE_MS: 15000,
    MAX_BATCH_PAUSE_MS: 600000,
    MAX_RECIPIENTS: 500,
};

interface BroadcastLog {
    id: string;
    sessionId: string;
    message: string;
    total: number;
    sent: number;
    failed: number;
    status: string;
    delay: number;
    error?: string | null;
    startedAt: string;
    completedAt: string | null;
    _count?: { recipients: number };
    recipients?: BroadcastRecipient[];
}

interface BroadcastRecipient {
    id: string;
    jid: string;
    status: string;
    error: string | null;
    sentAt: string | null;
}

export default function BroadcastPage() {
    const { sessionId } = useSession();
    const [contacts, setContacts] = useState("");
    const [message, setMessage] = useState("");
    const [mediaUrl, setMediaUrl] = useState("");
    const [mediaType, setMediaType] = useState("image");
    const [delay, setDelay] = useState([LIMITS.DEFAULT_DELAY_MS]);
    const [batchSize, setBatchSize] = useState(LIMITS.DEFAULT_BATCH_SIZE);
    const [batchPauseSec, setBatchPauseSec] = useState(LIMITS.DEFAULT_BATCH_PAUSE_MS / 1000);
    const [simulateTyping, setSimulateTyping] = useState(true);
    const [validateNumbers, setValidateNumbers] = useState(true);
    const [loading, setLoading] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [broadcastProgress, setBroadcastProgress] = useState<BroadcastProgress | null>(null);
    const [activeTab, setActiveTab] = useState<"new" | "history" | "guide">("new");
    const [shuffle, setShuffle] = useState(true);
    const [health, setHealth] = useState<BroadcastHealth | null>(null);

    // History
    const [history, setHistory] = useState<BroadcastLog[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [selectedLog, setSelectedLog] = useState<BroadcastLog | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);
    const [detailLoading, setDetailLoading] = useState(false);

    const { getSocket, joinSession } = useSocket();

    // Socket for progress updates
    useEffect(() => {
        const socket = getSocket();
        if (!socket || !sessionId) return;

        const onConnect = () => joinSession(sessionId);
        if (socket.connected) joinSession(sessionId);
        socket.on("connect", onConnect);

        const handler = (data: BroadcastProgress) => {
            setBroadcastProgress(prev => ({ ...(prev && prev.broadcastId === data.broadcastId ? prev : {}), ...data }));
            if (data.status !== "running") {
                setLoading(false);
                setCancelling(false);
                // Refresh history after completion
                fetchHistory();
                if (data.status === "completed") {
                    if (data.failed === 0) {
                        toast.success(`Broadcast complete! ${data.sent} sent.`);
                    } else {
                        toast.warning(`Broadcast complete. ${data.sent} sent, ${data.failed} failed.`);
                    }
                } else if (data.status === "cancelled") {
                    toast.info(`Broadcast cancelled. ${data.sent} sent before stopping.`);
                } else {
                    toast.error(data.error || `Broadcast stopped. ${data.sent} sent, ${data.failed} failed.`);
                }
            }
        };

        socket.on("broadcast.progress", handler);
        return () => { socket.off("connect", onConnect); socket.off("broadcast.progress", handler); };
    }, [sessionId, getSocket, joinSession]);

    // Fetch history
    const fetchHistory = useCallback(async () => {
        if (!sessionId) return;
        setHistoryLoading(true);
        try {
            const res = await fetch(`/api/messages/${sessionId}/broadcast/history?limit=20`);
            if (res.ok) {
                const data = await res.json();
                setHistory(data.data || []);
            }
        } catch (e) {
            console.error("Failed to fetch broadcast history", e);
        } finally {
            setHistoryLoading(false);
        }
    }, [sessionId]);

    // Load history on mount & tab switch
    useEffect(() => {
        if (activeTab === "history" && sessionId) {
            fetchHistory();
        }
    }, [activeTab, sessionId, fetchHistory]);

    // Number health (daily budget, quiet hours, opt-outs)
    const fetchHealth = useCallback(async () => {
        if (!sessionId) return;
        try {
            const res = await fetch(`/api/messages/${sessionId}/broadcast`);
            if (res.ok) {
                const data = await res.json();
                if (data?.data?.health) setHealth(data.data.health);
            }
        } catch (e) {
            console.error("Failed to fetch broadcast health", e);
        }
    }, [sessionId]);

    useEffect(() => {
        fetchHealth();
    }, [fetchHealth, broadcastProgress?.status]);

    // Open detail modal
    const openDetail = async (log: BroadcastLog) => {
        setSelectedLog(log);
        setDetailOpen(true);
        setDetailLoading(true);
        try {
            const res = await fetch(`/api/messages/${sessionId}/broadcast/history/${log.id}`);
            if (res.ok) {
                const data = await res.json();
                setSelectedLog(data.data);
            }
        } catch (e) {
            console.error("Failed to fetch broadcast detail", e);
        } finally {
            setDetailLoading(false);
        }
    };

    const handleSend = async () => {
        if (!sessionId) return toast.error("No active session found");
        if (!message.trim() && !mediaUrl.trim()) return toast.error("Message or media cannot be empty");
        setLoading(true);
        setBroadcastProgress(null);

        try {
            const recipients = contacts.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);

            if (recipients.length === 0) {
                toast.error("No recipients specified");
                setLoading(false);
                return;
            }

            if (recipients.length > LIMITS.MAX_RECIPIENTS) {
                toast.error(`Maximum ${LIMITS.MAX_RECIPIENTS} recipients per broadcast. Split the list and spread it over the day.`);
                setLoading(false);
                return;
            }

            const res = await fetch(`/api/messages/${sessionId}/broadcast`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    recipients,
                    message,
                    mediaUrl: mediaUrl.trim() || undefined,
                    mediaType: mediaUrl.trim() ? (mediaType || "image") : undefined,
                    delay: delay[0],
                    batchSize,
                    batchPauseMs: batchPauseSec * 1000,
                    simulateTyping,
                    validateNumbers,
                    shuffle
                })
            });

            const data = await res.json();

            if (res.ok) {
                const invalid: string[] = data?.data?.invalidRecipients || [];
                toast.info(`Broadcast started for ${data?.data?.total ?? recipients.length} recipients...`);
                if (invalid.length > 0) {
                    toast.warning(`${invalid.length} entr${invalid.length === 1 ? "y was" : "ies were"} ignored as invalid numbers: ${invalid.slice(0, 3).join(", ")}${invalid.length > 3 ? "…" : ""}`);
                }
            } else {
                toast.error(data.message || "Failed to start broadcast");
                setLoading(false);
            }
        } catch (e) {
            console.error(e);
            toast.error("Error sending broadcast");
            setLoading(false);
        }
    };

    const handleCancel = async (broadcastId?: string) => {
        const id = broadcastId || broadcastProgress?.broadcastId;
        if (!sessionId || !id) return;
        setCancelling(true);
        try {
            const res = await fetch(`/api/messages/${sessionId}/broadcast/${id}/cancel`, { method: "POST" });
            const data = await res.json();
            if (res.ok) {
                toast.info(data.message || "Cancellation requested");
                fetchHistory();
            } else {
                toast.error(data.message || "Failed to cancel broadcast");
                setCancelling(false);
            }
        } catch (e) {
            console.error(e);
            toast.error("Failed to cancel broadcast");
            setCancelling(false);
        }
    };

    const recipientCount = new Set(contacts.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)).size;

    // Rough runtime estimate: avg jitter is +30%, plus one cooldown per full batch.
    const estimateSeconds = (() => {
        if (recipientCount === 0) return 0;
        const perMessage = delay[0] * 1.3 / 1000 + (simulateTyping ? 2.5 : 0);
        const batches = Math.max(0, Math.ceil(recipientCount / Math.max(batchSize, 1)) - 1);
        return Math.round(recipientCount * perMessage + batches * batchPauseSec * 1.25);
    })();
    const formatDuration = (sec: number) => {
        if (sec < 60) return `${sec}s`;
        const m = Math.floor(sec / 60);
        if (m < 60) return `${m} min`;
        return `${Math.floor(m / 60)}h ${m % 60}m`;
    };

    const statusIcon = (status: string, failed: number, size = "h-8 w-8") => {
        if (status === "completed") {
            return failed === 0
                ? <CheckCircle2 className={`${size} text-green-500`} />
                : <AlertTriangle className={`${size} text-yellow-500`} />;
        }
        if (status === "cancelled") return <Ban className={`${size} text-slate-400`} />;
        if (status === "failed") return <XCircle className={`${size} text-red-500`} />;
        return <Radio className={`${size} text-blue-500 animate-pulse`} />;
    };
    const formatJid = (jid: string) => {
        if (!jid) return "-";
        return jid.replace("@s.whatsapp.net", "").replace("@g.us", " (Group)");
    };

    const formatTime = (ts: string) => {
        const d = new Date(ts);
        return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const tabs = [
        { id: "new" as const, label: "New Broadcast", icon: Send },
        { id: "history" as const, label: "History", icon: History },
        { id: "guide" as const, label: "Safety Guide", icon: BookOpen },
    ];

    const budgetPct = health && health.dailyLimit > 0 ? Math.min(100, Math.round((health.sentLast24h / health.dailyLimit) * 100)) : 0;
    const budgetTone = budgetPct >= 90 ? "text-red-600" : budgetPct >= 70 ? "text-yellow-600" : "text-green-600";

    return (
        <SessionGuard>
            <div className="space-y-6">
                <div>
                    <h2 className="text-xl sm:text-3xl font-bold tracking-tight">Broadcast / Blast</h2>
                    <p className="text-muted-foreground text-sm mt-1">Send bulk messages to multiple recipients at once.</p>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 bg-muted/50 p-1 rounded-lg w-fit">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-all ${
                                activeTab === tab.id
                                    ? "bg-background shadow-sm text-foreground"
                                    : "text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            <tab.icon className="h-4 w-4" />
                            {tab.label}
                        </button>
                    ))}
                </div>

                {activeTab === "new" && (
                    <>
                        <div className="grid gap-4 sm:gap-6 grid-cols-1 md:grid-cols-2">
                            {/* Recipients Card */}
                            <Card>
                                <CardHeader>
                                    <CardTitle>Recipients</CardTitle>
                                    <CardDescription>Enter phone numbers separated by comma or new line.</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="space-y-2">
                                        <Label>Target Numbers (e.g., 919876543210)</Label>
                                        <Textarea
                                            placeholder={"919876543210\n919876543211"}
                                            className="min-h-[200px] font-mono text-sm"
                                            value={contacts}
                                            onChange={e => setContacts(e.target.value)}
                                            disabled={loading}
                                        />
                                        <p className="text-xs text-muted-foreground">{recipientCount} numbers identified</p>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Message Card */}
                            <Card>
                                <CardHeader>
                                    <CardTitle>Message Content</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="space-y-2">
                                        <Label>Message (Optional if media attached)</Label>
                                        <p className="text-[11px] text-muted-foreground">
                                            Use <code className="bg-muted px-1 rounded">{"{name}"}</code> for the contact&apos;s name and <code className="bg-muted px-1 rounded">{"{Hi|Hello|Namaste}"}</code> to vary wording — identical texts to many people are a spam signal.
                                        </p>
                                        <Textarea
                                            placeholder="Type your message or media caption here..."
                                            className="min-h-[120px]"
                                            value={message}
                                            onChange={e => setMessage(e.target.value)}
                                            disabled={loading}
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <MediaUploadInput
                                            value={mediaUrl}
                                            mediaType={mediaType}
                                            onChange={(url, type) => {
                                                setMediaUrl(url);
                                                if (type) setMediaType(type);
                                            }}
                                            label="Media Attachment (Optional)"
                                            helperText="Attach an image, video, audio or document to broadcast"
                                        />
                                    </div>

                                    <div className="space-y-4 pt-2">
                                        <div className="space-y-2">
                                            <Label>Delay between messages: {(delay[0] / 1000).toFixed(0)}s</Label>
                                            <Slider
                                                min={LIMITS.MIN_DELAY_MS}
                                                max={60000}
                                                step={1000}
                                                value={delay}
                                                onValueChange={setDelay}
                                                disabled={loading}
                                            />
                                            <p className="text-xs text-muted-foreground">
                                                Random jitter of up to +60% is added on top. Minimum is {LIMITS.MIN_DELAY_MS / 1000}s; 8–15s is recommended for cold contacts.
                                            </p>
                                        </div>

                                        <div className="grid grid-cols-2 gap-3">
                                            <div className="space-y-1.5">
                                                <Label className="text-xs">Messages per batch</Label>
                                                <Input
                                                    type="number"
                                                    min={LIMITS.MIN_BATCH_SIZE}
                                                    max={LIMITS.MAX_BATCH_SIZE}
                                                    value={batchSize}
                                                    onChange={e => setBatchSize(Math.min(LIMITS.MAX_BATCH_SIZE, Math.max(LIMITS.MIN_BATCH_SIZE, parseInt(e.target.value) || LIMITS.DEFAULT_BATCH_SIZE)))}
                                                    disabled={loading}
                                                />
                                            </div>
                                            <div className="space-y-1.5">
                                                <Label className="text-xs">Pause between batches (s)</Label>
                                                <Input
                                                    type="number"
                                                    min={LIMITS.MIN_BATCH_PAUSE_MS / 1000}
                                                    max={LIMITS.MAX_BATCH_PAUSE_MS / 1000}
                                                    value={batchPauseSec}
                                                    onChange={e => setBatchPauseSec(Math.min(LIMITS.MAX_BATCH_PAUSE_MS / 1000, Math.max(LIMITS.MIN_BATCH_PAUSE_MS / 1000, parseInt(e.target.value) || LIMITS.DEFAULT_BATCH_PAUSE_MS / 1000)))}
                                                    disabled={loading}
                                                />
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between gap-3">
                                                <div>
                                                    <Label className="text-xs">Validate numbers first</Label>
                                                    <p className="text-[11px] text-muted-foreground">Skip numbers that are not on WhatsApp. Sending to dead numbers is a strong spam signal.</p>
                                                </div>
                                                <Switch checked={validateNumbers} onCheckedChange={setValidateNumbers} disabled={loading} />
                                            </div>
                                            <div className="flex items-center justify-between gap-3">
                                                <div>
                                                    <Label className="text-xs">Simulate typing</Label>
                                                    <p className="text-[11px] text-muted-foreground">Show &quot;typing…&quot; for a moment before each message.</p>
                                                </div>
                                                <Switch checked={simulateTyping} onCheckedChange={setSimulateTyping} disabled={loading} />
                                            </div>
                                            <div className="flex items-center justify-between gap-3">
                                                <div>
                                                    <Label className="text-xs">Random order</Label>
                                                    <p className="text-[11px] text-muted-foreground">Send in shuffled order instead of list order.</p>
                                                </div>
                                                <Switch checked={shuffle} onCheckedChange={setShuffle} disabled={loading} />
                                            </div>
                                        </div>

                                        {health && health.dailyLimit > 0 && health.remaining !== null && recipientCount > health.remaining && (
                                            <div className="flex items-start gap-2 text-xs text-red-600 bg-red-500/10 rounded-md px-3 py-2">
                                                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                                                <span>Only {health.remaining} of today&apos;s limit ({health.dailyLimit}) remain. Reduce the list to {health.remaining} or less, or change the limit in Bot Settings → Broadcast Safety.</span>
                                            </div>
                                        )}

                                        {recipientCount > 0 && (
                                            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                                                <Clock className="h-3.5 w-3.5" />
                                                Estimated time for {recipientCount} recipients: ~{formatDuration(estimateSeconds)}
                                            </p>
                                        )}

                                        <Button
                                            className="w-full"
                                            onClick={handleSend}
                                            disabled={loading || !sessionId || recipientCount === 0 || (!message.trim() && !mediaUrl.trim())}
                                        >
                                            {loading ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                                            {loading ? "Broadcasting..." : "Start Broadcast"}
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        </div>

                        {/* Number health */}
                        {health && (
                            <Card>
                                <CardHeader className="pb-3">
                                    <CardTitle className="flex items-center gap-2 text-base">
                                        <Gauge className="h-5 w-5 text-primary" /> Number Health
                                    </CardTitle>
                                    <CardDescription>Live view of this session&apos;s broadcast budget and protections. Limits are set in Bot Settings → Broadcast Safety.</CardDescription>
                                </CardHeader>
                                <CardContent className="grid gap-3 sm:grid-cols-4">
                                    <div className="rounded-lg border p-3 sm:col-span-2">
                                        <div className="flex justify-between text-xs text-muted-foreground mb-1">
                                            <span>Sent in last 24h</span>
                                            <span className={`font-mono font-medium ${budgetTone}`}>
                                                {health.sentLast24h}{health.dailyLimit > 0 ? ` / ${health.dailyLimit}` : " (no limit)"}
                                            </span>
                                        </div>
                                        <Progress value={health.dailyLimit > 0 ? budgetPct : 0} className="h-2" />
                                        <p className="text-[11px] text-muted-foreground mt-1">
                                            {health.dailyLimit > 0
                                                ? `${health.remaining ?? 0} remaining today`
                                                : "Set a daily limit to protect this number"}
                                        </p>
                                    </div>
                                    <div className="rounded-lg border p-3">
                                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><MoonStar className="h-3.5 w-3.5" /> Quiet hours</div>
                                        <p className={`text-sm font-medium mt-1 ${health.quietHours.active ? "text-yellow-600" : ""}`}>
                                            {health.quietHours.label || "Off"}
                                        </p>
                                        <p className="text-[11px] text-muted-foreground">{health.quietHours.active ? "Active now — sends will wait" : health.timezone}</p>
                                    </div>
                                    <div className="rounded-lg border p-3">
                                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><UserX className="h-3.5 w-3.5" /> Opted out</div>
                                        <p className="text-sm font-medium mt-1">{health.optedOutCount} contact{health.optedOutCount === 1 ? "" : "s"}</p>
                                        <p className="text-[11px] text-muted-foreground">Replied STOP — always skipped</p>
                                    </div>
                                    {health.lastDisconnectReason && (
                                        <div className="sm:col-span-4 flex items-start gap-2 text-xs text-yellow-700 bg-yellow-500/10 rounded-md px-3 py-2">
                                            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                                            <span><strong>Last disconnect:</strong> {health.lastDisconnectReason}</span>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}

                        {/* Safety guidance */}
                        <Card className="border-dashed">
                            <CardContent className="pt-5">
                                <div className="flex gap-3">
                                    <ShieldCheck className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
                                    <div className="text-xs text-muted-foreground space-y-1">
                                        <p className="font-medium text-foreground text-sm">Protect your number</p>
                                        <p>WhatsApp logs out (and eventually bans) numbers that send identical messages quickly to people who did not opt in. Keep a new number under ~50 cold recipients/day for the first weeks, stay under ~200/day on a warmed-up number, personalise the text, and message only people who expect to hear from you. If a broadcast is logged out mid-way, stop for 24h before trying again.</p>
                                        <button type="button" onClick={() => setActiveTab("guide")} className="text-primary underline underline-offset-2 font-medium">Read the full Safety Guide →</button>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        {/* Live Progress */}
                        {broadcastProgress && (
                            <Card className={`border-2 transition-colors ${
                                broadcastProgress.status === "completed"
                                    ? (broadcastProgress.failed === 0 ? "border-green-500/30 bg-green-50/30 dark:bg-green-950/10" : "border-yellow-500/30 bg-yellow-50/30 dark:bg-yellow-950/10")
                                    : broadcastProgress.status === "failed"
                                        ? "border-red-500/30 bg-red-50/30 dark:bg-red-950/10"
                                        : broadcastProgress.status === "cancelled"
                                            ? "border-slate-400/30 bg-slate-50/30 dark:bg-slate-950/10"
                                            : "border-blue-500/30 bg-blue-50/30 dark:bg-blue-950/10"
                            }`}>
                                <CardHeader className="pb-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <CardTitle className="flex items-center gap-2 text-lg">
                                                {broadcastProgress.status === "running" ? (
                                                    <><Radio className="h-5 w-5 text-blue-500 animate-pulse" /><span>Broadcast In Progress</span></>
                                                ) : broadcastProgress.status === "cancelled" ? (
                                                    <><Ban className="h-5 w-5 text-slate-500" /><span>Broadcast Cancelled</span></>
                                                ) : broadcastProgress.status === "failed" ? (
                                                    <><XCircle className="h-5 w-5 text-red-500" /><span>Broadcast Stopped</span></>
                                                ) : broadcastProgress.failed === 0 ? (
                                                    <><CheckCircle2 className="h-5 w-5 text-green-500" /><span>Broadcast Completed</span></>
                                                ) : (
                                                    <><AlertTriangle className="h-5 w-5 text-yellow-500" /><span>Broadcast Completed with Errors</span></>
                                                )}
                                            </CardTitle>
                                            <CardDescription>ID: {broadcastProgress.broadcastId}</CardDescription>
                                        </div>
                                        {broadcastProgress.status === "running" && (
                                            <Button variant="destructive" size="sm" onClick={() => handleCancel()} disabled={cancelling}>
                                                {cancelling ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : <Ban className="h-4 w-4 mr-1" />}
                                                {cancelling ? "Stopping…" : "Stop"}
                                            </Button>
                                        )}
                                    </div>
                                    {broadcastProgress.error && (
                                        <div className="mt-2 flex items-start gap-2 text-sm text-red-600 bg-red-500/10 rounded-md px-3 py-2">
                                            <Info className="h-4 w-4 mt-0.5 shrink-0" />
                                            <span>{broadcastProgress.error}</span>
                                        </div>
                                    )}
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="space-y-2">
                                        <div className="flex justify-between text-sm">
                                            <span className="text-muted-foreground">Progress</span>
                                            <span className="font-mono font-medium">
                                                {broadcastProgress.sent + broadcastProgress.failed} / {broadcastProgress.total} ({broadcastProgress.progress || 0}%)
                                            </span>
                                        </div>
                                        <Progress value={broadcastProgress.progress || 0} className="h-3" />
                                    </div>

                                    <div className="grid grid-cols-3 gap-3">
                                        <div className="bg-background rounded-lg p-3 text-center border">
                                            <div className="text-2xl font-bold text-green-600">{broadcastProgress.sent}</div>
                                            <div className="text-xs text-muted-foreground flex items-center justify-center gap-1 mt-1">
                                                <CheckCircle2 className="h-3 w-3" /> Sent
                                            </div>
                                        </div>
                                        <div className="bg-background rounded-lg p-3 text-center border">
                                            <div className="text-2xl font-bold text-red-500">{broadcastProgress.failed}</div>
                                            <div className="text-xs text-muted-foreground flex items-center justify-center gap-1 mt-1">
                                                <XCircle className="h-3 w-3" /> Failed
                                            </div>
                                        </div>
                                        <div className="bg-background rounded-lg p-3 text-center border">
                                            <div className="text-2xl font-bold text-muted-foreground">
                                                {broadcastProgress.total - broadcastProgress.sent - broadcastProgress.failed}
                                            </div>
                                            <div className="text-xs text-muted-foreground flex items-center justify-center gap-1 mt-1">
                                                <Clock className="h-3 w-3" /> Pending
                                            </div>
                                        </div>
                                    </div>

                                    {broadcastProgress.status === "running" && (broadcastProgress.note || broadcastProgress.current) && (
                                        <div className="flex items-center gap-2 text-sm px-3 py-2 bg-muted/50 rounded-lg">
                                            <RefreshCw className="h-3.5 w-3.5 animate-spin text-blue-500" />
                                            {broadcastProgress.note ? (
                                                <span className="text-muted-foreground">{broadcastProgress.note}</span>
                                            ) : (
                                                <>
                                                    <span className="text-muted-foreground">Now sending:</span>
                                                    <span className="font-mono font-medium">{formatJid(broadcastProgress.current!)}</span>
                                                </>
                                            )}
                                        </div>
                                    )}

                                    {broadcastProgress.status !== "running" && broadcastProgress.errors && broadcastProgress.errors.length > 0 && (
                                        <div className="space-y-2">
                                            <h4 className="text-sm font-semibold text-red-600 flex items-center gap-1.5">
                                                <XCircle className="h-4 w-4" /> Failed ({broadcastProgress.errors.length})
                                            </h4>
                                            <div className="max-h-40 overflow-y-auto bg-red-50 dark:bg-red-950/30 rounded-lg p-2 space-y-1">
                                                {broadcastProgress.errors.map((err, i) => (
                                                    <div key={i} className="flex justify-between items-center text-xs py-1 px-2 bg-background/60 rounded">
                                                        <span className="font-mono">{formatJid(err.jid)}</span>
                                                        <span className="text-red-500 truncate ml-2 max-w-[200px]">{err.error}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}
                    </>
                )}

                {activeTab === "history" && (
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <History className="h-5 w-5" />
                                Broadcast History
                            </CardTitle>
                            <CardDescription>History of sent broadcasts, stored permanently.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {historyLoading ? (
                                <div className="flex items-center justify-center py-8">
                                    <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                                </div>
                            ) : history.length === 0 ? (
                                <div className="text-center py-8 text-muted-foreground">
                                    <p className="text-sm">No broadcasts yet.</p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {history.map(log => (
                                        <div key={log.id}
                                            className="flex items-center gap-4 p-3 rounded-lg border hover:bg-muted/30 transition-colors"
                                        >
                                            {/* Status icon */}
                                            <div className="shrink-0">
                                                {statusIcon(log.status, log.failed)}
                                            </div>

                                            {/* Info */}
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium truncate">{log.message}</p>
                                                {log.error && (
                                                    <p className="text-xs text-red-500 truncate mt-0.5" title={log.error}>{log.error}</p>
                                                )}
                                                <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                                                    <span className="flex items-center gap-1">
                                                        <CheckCircle2 className="h-3 w-3 text-green-500" /> {log.sent}
                                                    </span>
                                                    <span className="flex items-center gap-1">
                                                        <XCircle className="h-3 w-3 text-red-500" /> {log.failed}
                                                    </span>
                                                    <span className="flex items-center gap-1">
                                                        <Calendar className="h-3 w-3" /> {formatTime(log.startedAt)}
                                                    </span>
                                                </div>
                                            </div>

                                            {/* Actions */}
                                            {log.status === "running" && (
                                                <Button variant="ghost" size="sm" className="shrink-0 text-red-500" onClick={() => handleCancel(log.id)}>
                                                    <Ban className="h-4 w-4 mr-1" /> Stop
                                                </Button>
                                            )}
                                            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => openDetail(log)}>
                                                <Eye className="h-4 w-4 mr-1" /> Detail
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                )}

                {activeTab === "guide" && (
                    <div className="grid gap-4 lg:grid-cols-2">
                        <Card className="lg:col-span-2 border-green-500/30 bg-green-50/30 dark:bg-green-950/10">
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <ShieldCheck className="h-5 w-5 text-green-600" /> Why numbers get logged out or banned
                                </CardTitle>
                                <CardDescription>Read this before every campaign. It applies to everyone who sends from this account, including staff.</CardDescription>
                            </CardHeader>
                            <CardContent className="text-sm space-y-2 text-muted-foreground">
                                <p>WhatsApp has no bulk-messaging allowance for normal numbers. Every broadcast is a series of ordinary chat messages, and WhatsApp&apos;s anti-spam system judges them like it judges a human: by <strong className="text-foreground">volume</strong>, <strong className="text-foreground">speed</strong>, <strong className="text-foreground">repetition</strong>, <strong className="text-foreground">recipient reaction</strong> (blocks, reports, no replies) and whether the recipients <strong className="text-foreground">know you</strong>.</p>
                                <p>The first penalty is usually a forced logout of the linked device (code 401 <code className="bg-muted px-1 rounded">device_removed</code>). The session shows as LOGGED OUT and the rest of the broadcast fails. Repeated flags lead to a temporary ban (hours to days) and then a permanent ban of the number.</p>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">Daily volume guidance</CardTitle>
                                <CardDescription>&quot;Cold&quot; = the recipient has never messaged you. Spread sends across the day, never in one run.</CardDescription>
                            </CardHeader>
                            <CardContent className="text-sm">
                                <table className="w-full text-left">
                                    <thead className="text-xs text-muted-foreground">
                                        <tr><th className="pb-2 font-medium">Number age</th><th className="pb-2 font-medium">Cold recipients / day</th></tr>
                                    </thead>
                                    <tbody className="[&_td]:py-2 [&_tr]:border-t">
                                        <tr><td>New number (first 2–3 weeks)</td><td><strong>20–50</strong> — warm up by chatting normally, replying first, joining groups</td></tr>
                                        <tr><td>Warmed-up number</td><td><strong>100–200</strong></td></tr>
                                        <tr><td>Number with established two-way chats</td><td><strong>200–500</strong>, only to people who replied before</td></tr>
                                    </tbody>
                                </table>
                                <p className="text-xs text-muted-foreground mt-3">The daily limit in Bot Settings → Broadcast Safety enforces this automatically for this session.</p>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">Content rules of thumb</CardTitle>
                            </CardHeader>
                            <CardContent className="text-sm">
                                <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
                                    <li><strong className="text-foreground">Personalise.</strong> Use <code className="bg-muted px-1 rounded">{"{name}"}</code> and spintax like <code className="bg-muted px-1 rounded">{"{Hi|Hello|Namaste}"}</code> so no two messages are identical.</li>
                                    <li>One link at most, on your own domain. No link shorteners.</li>
                                    <li>Put text in the media caption instead of sending two messages per person.</li>
                                    <li>Keep the first message short and easy to answer. Mention how to opt out (&quot;Reply STOP&quot;).</li>
                                    <li>Never message people who did not give you their number or agree to hear from you.</li>
                                </ul>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">Operational rules</CardTitle>
                            </CardHeader>
                            <CardContent className="text-sm">
                                <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
                                    <li>Use a <strong className="text-foreground">dedicated number</strong> for broadcasts, never the main business line.</li>
                                    <li>Keep the phone online on a stable connection with WhatsApp updated.</li>
                                    <li>Respect quiet hours (10 PM – 8 AM). Night-time messages get reported.</li>
                                    <li>If a run is logged out: <strong className="text-foreground">stop for 24 hours</strong>, re-link, resume at half the volume.</li>
                                    <li>&quot;Forbidden (403)&quot; on reconnect means the number is restricted — wait, do not keep retrying.</li>
                                    <li>Check <em>History → Detail</em>: the error column says exactly why each recipient failed.</li>
                                    <li>Large promotional campaigns belong on the official <strong className="text-foreground">WhatsApp Business Platform (Cloud API)</strong> with approved templates. That is the only sanctioned way to do bulk outreach.</li>
                                </ul>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">What the engine does for you</CardTitle>
                            </CardHeader>
                            <CardContent className="text-sm">
                                <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
                                    <li>Verifies every number on WhatsApp first and skips dead numbers.</li>
                                    <li>Minimum {LIMITS.MIN_DELAY_MS / 1000}s delay, {LIMITS.DEFAULT_DELAY_MS / 1000}s default, random jitter up to +60%, cooldown after every batch.</li>
                                    <li>Shows &quot;typing…&quot; before each message and sends in random order.</li>
                                    <li>Enforces the daily limit and quiet hours; skips contacts who replied STOP.</li>
                                    <li>Waits through short reconnects, stops cleanly on logout and after 5 consecutive failures, and records the reason.</li>
                                    <li>Max {LIMITS.MAX_RECIPIENTS} recipients per run; Stop button at any time.</li>
                                </ul>
                                <p className="text-xs text-muted-foreground mt-3">These defaults reduce risk. They cannot make unsolicited bulk messaging safe.</p>
                            </CardContent>
                        </Card>
                    </div>
                )}

                {/* Detail Modal */}
                <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
                    <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                {selectedLog ? statusIcon(selectedLog.status, selectedLog.failed, "h-5 w-5") : null}
                                Broadcast Detail
                                {selectedLog && selectedLog.status !== "completed" && (
                                    <span className="text-xs font-normal uppercase tracking-wide px-2 py-0.5 rounded bg-muted">{selectedLog.status}</span>
                                )}
                            </DialogTitle>
                        </DialogHeader>

                        {detailLoading ? (
                            <div className="flex items-center justify-center py-8">
                                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                            </div>
                        ) : selectedLog ? (
                            <div className="flex flex-col gap-4 overflow-hidden min-h-0">
                                {/* Summary */}
                                <div className="grid grid-cols-3 gap-3">
                                    <div className="bg-muted/30 rounded-lg p-3 text-center">
                                        <div className="text-xl font-bold text-green-600">{selectedLog.sent}</div>
                                        <div className="text-xs text-muted-foreground">Sent</div>
                                    </div>
                                    <div className="bg-muted/30 rounded-lg p-3 text-center">
                                        <div className="text-xl font-bold text-red-500">{selectedLog.failed}</div>
                                        <div className="text-xs text-muted-foreground">Failed</div>
                                    </div>
                                    <div className="bg-muted/30 rounded-lg p-3 text-center">
                                        <div className="text-xl font-bold">{selectedLog.total}</div>
                                        <div className="text-xs text-muted-foreground">Total</div>
                                    </div>
                                </div>

                                {selectedLog.error && (
                                    <div className="flex items-start gap-2 text-sm text-red-600 bg-red-500/10 rounded-md px-3 py-2">
                                        <Info className="h-4 w-4 mt-0.5 shrink-0" />
                                        <span>{selectedLog.error}</span>
                                    </div>
                                )}

                                {/* Message */}
                                <div className="bg-muted/30 rounded-lg p-3">
                                    <p className="text-xs text-muted-foreground mb-1">Message:</p>
                                    <p className="text-sm whitespace-pre-wrap break-words">{selectedLog.message}</p>
                                </div>

                                {/* Time */}
                                <div className="flex gap-4 text-xs text-muted-foreground">
                                    <span>Started: {formatTime(selectedLog.startedAt)}</span>
                                    {selectedLog.completedAt && <span>Completed: {formatTime(selectedLog.completedAt)}</span>}
                                </div>

                                {/* Recipients list */}
                                {selectedLog.recipients && selectedLog.recipients.length > 0 && (
                                    <div className="flex-1 overflow-y-auto min-h-0">
                                        <h4 className="text-sm font-semibold mb-2">Recipients ({selectedLog.recipients.length})</h4>
                                        <div className="space-y-1">
                                            {selectedLog.recipients.map(r => (
                                                <div key={r.id}
                                                    className={`flex items-center justify-between gap-2 text-xs py-1.5 px-2 rounded ${
                                                        r.status === "sent" ? "bg-green-500/5" :
                                                        r.status === "failed" ? "bg-red-500/5" : "bg-muted/30"
                                                    }`}
                                                >
                                                    <span className="font-mono truncate">{formatJid(r.jid)}</span>
                                                    <div className="flex items-center gap-2 shrink-0">
                                                        <span className={`px-1.5 py-0.5 rounded font-medium ${
                                                            r.status === "sent" ? "text-green-600 bg-green-500/10" :
                                                            r.status === "failed" ? "text-red-500 bg-red-500/10" : "text-muted-foreground bg-muted/50"
                                                        }`}>
                                                            {r.status}
                                                        </span>
                                                        {r.error && (
                                                            <span className="text-red-500 max-w-[200px] truncate" title={r.error}>{r.error}</span>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : null}
                    </DialogContent>
                </Dialog>
            </div>
        </SessionGuard>
    );
}
