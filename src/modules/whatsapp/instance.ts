import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    WASocket,
    ConnectionState,
    proto,
    WAMessageKey
} from "@whiskeysockets/baileys";
import { prisma } from "@/lib/prisma";
import { usePrismaAuthState } from "./auth/usePrismaAuthState";
import { Server } from "socket.io";
import pino from "pino";
import { bindSessionStore, mergeLidContacts } from "./store";
import { syncGroups } from "./store/groups";
import { bindContactSync } from "./store/contacts";
import { bindAutoReply } from "./store/autoreply";
import { bindPpGuard } from "./store/ppguard";
import { antispam } from "./antispam";
import { logger } from "@/lib/logger";
import { onConnectionUpdate } from "@/lib/webhook";
import { sendAlert } from "@/lib/alerts";

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 60000;
/** How long we keep outgoing message bodies for retry-receipt re-delivery. */
const SENT_MESSAGE_TTL_MS = 10 * 60 * 1000;
const SENT_MESSAGE_CACHE_MAX = 2000;

/** Map Baileys disconnect codes to a human-readable explanation we can show the user. */
function explainDisconnect(code: number | undefined, rawMessage: string): string {
    switch (code) {
        case DisconnectReason.loggedOut:
            if (/device_removed/i.test(rawMessage)) {
                return "WhatsApp removed this linked device (401 device_removed). This usually happens when WhatsApp's anti-spam flags bulk/unsolicited messaging, or when the device was unlinked from the phone.";
            }
            if (/conflict/i.test(rawMessage)) {
                return "WhatsApp reported a device conflict (401 conflict). The account was linked elsewhere or the session was replaced.";
            }
            return `WhatsApp logged this device out (401). ${rawMessage}`.trim();
        case DisconnectReason.connectionReplaced:
            return "Connection replaced (440): the same session was opened somewhere else.";
        case DisconnectReason.badSession:
            return "Bad session (500): stored credentials are corrupt. Delete the session and scan the QR again.";
        case DisconnectReason.multideviceMismatch:
            return "Multi-device mismatch (411). Re-pair the device.";
        case DisconnectReason.forbidden:
            return "Forbidden (403): WhatsApp refused the connection. The number may be banned or restricted.";
        case DisconnectReason.restartRequired:
            return "Restart required (515) — normal after pairing, reconnecting.";
        case DisconnectReason.unavailableService:
            return "WhatsApp service unavailable (503).";
        case DisconnectReason.connectionLost:
        case DisconnectReason.connectionClosed:
            return `Connection lost (${code}). ${rawMessage}`.trim();
        default:
            return rawMessage || `Disconnected (code ${code ?? "unknown"})`;
    }
}

export class WhatsAppInstance {
    socket: WASocket | null = null;
    qr: string | null = null;
    rq: string | null = null;
    status: string = "DISCONNECTED";
    sessionId: string;
    userId: string;
    io: Server;
    config: any = {};
    startTime: Date | null = null;
    pairingCode: string | null = null;
    /** Last disconnect explanation (shown in dashboard / logs). */
    lastDisconnectReason: string | null = null;

    isStopped: boolean = false;
    private reconnectCount: number = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private initializing = false;
    private sentMessages = new Map<string, { message: proto.IMessage; at: number }>();
    /** Called when instance auto-stops or logs out — lets manager remove it from Map */
    onRemovedFromManager: (() => void) | null = null;

    constructor(sessionId: string, userId: string, io: Server) {
        this.sessionId = sessionId;
        this.userId = userId;
        this.io = io;
    }

    private emitStatus(payload: Record<string, any>) {
        const full = { sessionId: this.sessionId, ...payload };
        // Only sockets that passed the access check for this session are in its room.
        // (Previously this was also broadcast to every connected client.)
        this.io?.to(this.sessionId).emit("connection.update", full);
        // Webhook subscribers never received connection.update before — fire it here.
        if (typeof payload.status === "string") {
            onConnectionUpdate(this.sessionId, payload.status, payload.qr || undefined);
        }
    }

    /** Detach listeners and close the current socket without triggering the reconnect logic. */
    private disposeSocket() {
        const old = this.socket;
        if (!old) return;
        this.socket = null;
        try { old.ev.removeAllListeners("connection.update"); } catch { /* ignore */ }
        try { old.ev.removeAllListeners("creds.update"); } catch { /* ignore */ }
        try { old.ev.removeAllListeners("messages.upsert"); } catch { /* ignore */ }
        try { old.ev.removeAllListeners("messages.update"); } catch { /* ignore */ }
        try { old.ev.removeAllListeners("contacts.update"); } catch { /* ignore */ }
        try { old.ev.removeAllListeners("contacts.upsert"); } catch { /* ignore */ }
        try { old.ev.removeAllListeners("messaging-history.set"); } catch { /* ignore */ }
        try { old.ev.removeAllListeners("groups.update"); } catch { /* ignore */ }
        try { old.ev.removeAllListeners("group-participants.update"); } catch { /* ignore */ }
        try { old.end(undefined); } catch { /* ignore */ }
    }

    private clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private rememberSentMessage(key: WAMessageKey | undefined, message: proto.IMessage | null | undefined) {
        if (!key?.id || !message) return;
        const now = Date.now();
        this.sentMessages.set(key.id, { message, at: now });
        if (this.sentMessages.size > SENT_MESSAGE_CACHE_MAX) {
            for (const [id, entry] of this.sentMessages) {
                if (now - entry.at > SENT_MESSAGE_TTL_MS || this.sentMessages.size > SENT_MESSAGE_CACHE_MAX) {
                    this.sentMessages.delete(id);
                } else {
                    break;
                }
            }
        }
    }

    async init() {
        if (this.initializing) {
            logger.debug("Instance", `Session ${this.sessionId} init already in progress, skipping`);
            return;
        }
        this.initializing = true;
        this.clearReconnectTimer();

        try {
            const sessionData = await prisma.session.findUnique({
                where: { sessionId: this.sessionId },
                include: { botConfig: true }
            });
            if (!sessionData) {
                logger.warn("Instance", `Session ${this.sessionId} not found in DB, aborting init`);
                return;
            }
            this.config = sessionData?.config || {};
            const botConfig = (sessionData as any)?.botConfig;

            // Never run two live sockets for one session (double handlers = double CPU, double sends).
            this.disposeSocket();

            const { state, saveCreds } = await usePrismaAuthState(this.sessionId);
            const { version } = await fetchLatestBaileysVersion();

            const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || "error" }) as any;

            const sock = makeWASocket({
                version,
                logger: baileysLogger,
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
                },
                browser: ["Ubuntu", "Chrome", "20.0.04"],
                // Showing the device as permanently "online" is an automation signal and also
                // suppresses notifications on the phone. Off unless the user opted in.
                markOnlineOnConnect: botConfig?.alwaysOnline ?? false,
                syncFullHistory: false,
                // Lets Baileys answer retry receipts for messages we just sent; without it
                // recipients that ask for a re-send never get the message.
                getMessage: async (key) => {
                    const entry = key?.id ? this.sentMessages.get(key.id) : undefined;
                    return entry?.message || undefined;
                }
            });
            this.socket = sock;

            // Apply Anti-Spam wrapper + remember sent payloads for retry receipts
            const originalSendMessage = sock.sendMessage.bind(sock);
            const sessionId = this.sessionId;
            const self = this;
            sock.sendMessage = async function (jid: string, content: any, options?: any) {
                await antispam.enqueue(sessionId, jid, content);
                const result = await originalSendMessage(jid, content, options);
                self.rememberSentMessage(result?.key, result?.message);
                return result;
            } as any;

            // Bind Store for DB Sync
            bindSessionStore(sock, this.sessionId, this.io);

            // Bind Contact Sync
            bindContactSync(sock, this.sessionId);

            sock.ev.on("creds.update", saveCreds);

            sock.ev.on("connection.update", async (update) => {
                // Ignore events from a socket we already replaced or disposed.
                if (this.socket !== sock) return;
                await this.handleConnectionUpdate(update, sock);
            });
        } finally {
            this.initializing = false;
        }
    }

    async handleConnectionUpdate(update: Partial<ConnectionState>, sock?: WASocket) {
        const { connection, lastDisconnect, qr } = update;

        try {
            if (qr) {
                if (this.isStopped) return;
                // Reset reconnect count on new QR (user is re-scanning)
                this.reconnectCount = 0;
                this.qr = qr;
                this.status = "SCAN_QR";

                this.emitStatus({ status: this.status, qr });

                await prisma.session.update({
                    where: { sessionId: this.sessionId },
                    data: { qr, status: "SCAN_QR" }
                });
            }

            if (connection === "close") {
                const err: any = lastDisconnect?.error;
                const code: number | undefined = err?.output?.statusCode;
                const rawMessage: string = err?.message || err?.output?.payload?.message || "";
                const reason = explainDisconnect(code, rawMessage);
                this.lastDisconnectReason = reason;
                const isLoggedOut = code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden;

                logger.warn("Instance", `Session ${this.sessionId} connection closed. code=${code ?? "n/a"} reason="${reason}"`);

                if (isLoggedOut) {
                    // Logged out: stop permanently, remove from memory
                    this.status = "LOGGED_OUT";
                    this.clearReconnectTimer();
                    this.disposeSocket();
                    this.config = {};
                    this.emitStatus({ status: "LOGGED_OUT", qr: null, reason });

                    logger.error("Instance", `Session ${this.sessionId} LOGGED OUT: ${reason}`);
                    try {
                        await prisma.$transaction([
                            prisma.session.update({
                                where: { sessionId: this.sessionId },
                                data: { status: "LOGGED_OUT", qr: null }
                            }),
                            prisma.authState.deleteMany({
                                where: { sessionId: this.sessionId }
                            })
                        ]);
                    } catch (e) { /* ignore */ }
                    logger.info("Instance", `Session ${this.sessionId} credentials deleted.`);

                    await this.notifyOwner(
                        `WhatsApp session "${this.sessionId}" was logged out`,
                        `${reason}\n\nYou need to scan the QR code again. If this happened during a broadcast, reduce the volume, increase the delay, and only message people who expect to hear from you — repeated flags can lead to a permanent number ban.`,
                        "WARNING"
                    );
                    sendAlert({
                        kind: "logout",
                        title: `Session ${this.sessionId} LOGGED OUT`,
                        message: `${reason}\n\nScan the QR again from Sessions. If this happened during a broadcast: wait 24h, then resume at half the volume.`,
                        href: "/dashboard/sessions",
                        dedupeKey: `logout:${this.sessionId}`
                    }).catch(() => {});

                    // Remove from memory manager
                    this.onRemovedFromManager?.();
                    return;
                }

                if (this.isStopped) {
                    // Explicitly stopped: preserve creds for restart
                    this.status = "STOPPED";
                    this.disposeSocket();
                    this.reconnectCount = 0;
                    this.emitStatus({ status: "STOPPED", qr: null });

                    await prisma.session.update({
                        where: { sessionId: this.sessionId },
                        data: { status: "STOPPED", qr: null }
                    }).catch(() => {});
                    logger.warn("Instance", `Session ${this.sessionId} stopped. Credentials preserved.`);

                    // Remove from memory manager
                    const { waManager } = require("./manager");
                    waManager.removeInstance(this.sessionId);
                    return;
                }

                // 515 after pairing is expected — reconnect right away and don't count it as a failure.
                const isRestartRequired = code === DisconnectReason.restartRequired;
                if (!isRestartRequired) this.reconnectCount++;
                const remaining = MAX_RECONNECT_ATTEMPTS - this.reconnectCount + 1;

                if (isRestartRequired || remaining > 0) {
                    this.status = "DISCONNECTED";
                    // The old socket is dead; drop it so callers see "not connected" instead of
                    // getting "Connection Closed" errors while we back off.
                    this.disposeSocket();
                    this.emitStatus({ status: "DISCONNECTED", qr: null, reason });
                    await prisma.session.update({
                        where: { sessionId: this.sessionId },
                        data: { status: "DISCONNECTED", qr: null }
                    }).catch(() => {});

                    const delay = isRestartRequired
                        ? 1000
                        : Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectCount - 1));

                    logger.warn("Instance",
                        `Session ${this.sessionId} disconnected. Reconnecting in ${Math.round(delay / 1000)}s (${isRestartRequired ? "restart required" : `${this.reconnectCount}/${MAX_RECONNECT_ATTEMPTS}`})...`
                    );
                    this.clearReconnectTimer();
                    this.reconnectTimer = setTimeout(() => {
                        this.reconnectTimer = null;
                        if (!this.isStopped) {
                            this.init().catch(e => logger.error("Instance", `Reconnect init failed for ${this.sessionId}`, e));
                        }
                    }, delay);
                } else {
                    // Max retries exceeded — auto-stop
                    this.status = "STOPPED";
                    this.disposeSocket();
                    this.reconnectCount = 0;
                    this.isStopped = true; // prevent further retries
                    this.emitStatus({ status: "STOPPED", qr: null, reason });

                    await prisma.session.update({
                        where: { sessionId: this.sessionId },
                        data: { status: "STOPPED", qr: null }
                    }).catch(() => {});
                    logger.error("Instance",
                        `Session ${this.sessionId} max reconnects (${MAX_RECONNECT_ATTEMPTS}) reached. Auto-stopped. Last reason: ${reason}`
                    );

                    await this.notifyOwner(
                        `WhatsApp session "${this.sessionId}" stopped after repeated disconnects`,
                        `${reason}\n\nThe session was stopped after ${MAX_RECONNECT_ATTEMPTS} failed reconnect attempts. Open Sessions and click Start to try again.`,
                        "WARNING"
                    );
                    sendAlert({
                        kind: "logout",
                        title: `Session ${this.sessionId} auto-stopped`,
                        message: `${reason}\n\nStopped after ${MAX_RECONNECT_ATTEMPTS} failed reconnect attempts. Check the phone's internet and click Start in Sessions.`,
                        href: "/dashboard/sessions",
                        dedupeKey: `autostop:${this.sessionId}`
                    }).catch(() => {});

                    // Remove from memory manager
                    this.onRemovedFromManager?.();
                }
            }

            if (connection === "open") {
                // Connected — reset reconnect count
                this.reconnectCount = 0;
                this.isStopped = false;
                this.status = "CONNECTED";
                this.qr = null;
                this.startTime = new Date();
                this.lastDisconnectReason = null;

                this.emitStatus({ status: "CONNECTED", qr: null });

                const liveSock = (sock || this.socket) as WASocket;
                try {
                    await syncGroups(liveSock, this.sessionId);
                } catch (e) {
                    logger.error("Instance", "Group sync failed:", e);
                }

                bindAutoReply(liveSock, this.sessionId);
                bindPpGuard(liveSock, this.sessionId);

                await prisma.session.update({
                    where: { sessionId: this.sessionId },
                    data: { status: "CONNECTED", qr: null }
                });

                logger.success("Instance", `Session ${this.sessionId} connected and synced successfully`);
                // Repair contacts that were stored under a LID instead of a phone number (runs in the background).
                if (this.socket) setTimeout(() => { mergeLidContacts(this.socket!, this.sessionId).catch(() => {}); }, 15_000).unref();
            }
        } catch (error: any) {
            if (error.code === 'P2025') {
                logger.warn("Instance", `Session ${this.sessionId} record not found during update. Stopping.`);
                this.isStopped = true;
                this.disposeSocket();
            } else {
                logger.error("Instance", "Error in handleConnectionUpdate:", error);
            }
        }
    }

    /** Create a dashboard notification for the session owner and push it over Socket.IO. */
    private async notifyOwner(title: string, message: string, type: "INFO" | "WARNING" | "SUCCESS" | "SYSTEM") {
        try {
            const notification = await prisma.notification.create({
                data: {
                    userId: this.userId,
                    title,
                    message,
                    type,
                    href: "/dashboard/sessions"
                }
            });
            this.io?.to(`user:${this.userId}`).emit("notification:new", {
                id: notification.id,
                userId: this.userId,
                title,
                message,
                type,
                href: "/dashboard/sessions",
                createdAt: notification.createdAt
            });
        } catch (e) {
            logger.debug("Instance", "Failed to create owner notification", e);
        }
    }

    async requestPairingCode(phoneNumber: string) {
        if (!this.socket) {
            throw new Error("Socket not initialized");
        }

        try {
            const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
            if (!cleanNumber) throw new Error("Invalid phone number");

            const code = await this.socket.requestPairingCode(cleanNumber);
            this.pairingCode = code;
            this.status = "SCAN_QR";

            this.emitStatus({
                status: this.status,
                qr: this.qr,
                pairingCode: code
            });

            return code;
        } catch (error) {
            logger.error("Instance", "Pairing code error:", error);
            throw error;
        }
    }

    /** Clean shutdown without triggering reconnect */
    async shutdown() {
        this.isStopped = true;
        this.clearReconnectTimer();
        this.disposeSocket();
        this.reconnectCount = 0;
        this.sentMessages.clear();
    }
}
