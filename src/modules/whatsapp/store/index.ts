import { prisma } from "@/lib/prisma";
import type { WASocket, WAMessage, Contact } from "@whiskeysockets/baileys";
import { normalizeMessageContent } from "@whiskeysockets/baileys";
import { onMessageReceived, onMessageSent, dispatchWebhook, downloadAndSaveMedia } from "@/lib/webhook";
import { handleBotCommand, setSessionStartTime } from "../bot/command-handler";
import { handleOptOut } from "../safety";
import { resolveToPhoneJid, isLidJid, normalizeJid, lidToPhoneJidViaSocket } from "@/lib/jid-utils";

import { Server } from "socket.io";
import { logger } from "@/lib/logger";

export const bindSessionStore = (sock: WASocket, sessionId: string, io: Server | null) => {
    // Set start time for uptime command
    setSessionStartTime(sessionId);

    // First, get the database Session ID (cuid)
    let dbSessionId: string | null = null;

    // Initialize by fetching the session ID
    (async () => {
        const session = await prisma.session.findUnique({
            where: { sessionId },
            select: { id: true }
        });
        if (session) {
            dbSessionId = session.id;
            logger.info("Store", `Message store initialized for session ${sessionId} (db: ${dbSessionId})`);
        } else {
            logger.error("Store", `Session ${sessionId} not found for message store`);
        }
    })();

    // Handle Messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Process all message types: notify, append, and history sync
        if (type !== 'notify' && type !== 'append') {
            // For history sync, we still want to save messages
            logger.debug("Store", `Received ${messages.length} messages of type: ${type}`);
        }

        // Emit to socket room for real-time frontend updates
        if (type === 'notify' || type === 'append') {
            io?.to(sessionId).emit('message.upsert', { messages, type });
        }

        // Ensure we have the database session ID
        if (!dbSessionId) {
            const session = await prisma.session.findUnique({ where: { sessionId }, select: { id: true } });
            if (!session) return;
            dbSessionId = session.id;
        }

        const processedMessages = [];

        // Fetch Bot Config for auto-read & welcome message
        const config = await prisma.botConfig.findUnique({
            where: { sessionId: dbSessionId }
        });

        for (const msg of messages) {
            try {
                // Auto Read Logic
                if (type === 'notify' && (config as any)?.autoRead && !msg.key.fromMe) {
                    await sock.readMessages([msg.key]);
                }

                const savedMessage = await processAndSaveMessage(msg, dbSessionId, sessionId, type === 'notify', sock, config, io);
                if (savedMessage) {
                    processedMessages.push(savedMessage);
                }

                // Execute Bot Commands (Only for Notify / New Messages)
                if (type === 'notify' && savedMessage) {
                    // Run in background, don't await strictly to not block saving
                    handleBotCommand(sock, sessionId, msg, config ?? null).catch(e => logger.error("Bot", "Bot Handler Error", e));
                    // STOP / UNSUBSCRIBE replies flag the contact so broadcasts skip them
                    if (!msg.key.fromMe) {
                        handleOptOut(sock, dbSessionId, msg, config).catch(e => logger.error("Safety", "Opt-out error", e));
                    }
                }
            } catch (error) {
                logger.error("Store", "Error saving message", error);
            }
        }

        // Emit to socket room for real-time frontend updates
        if (processedMessages.length > 0) {
            // Serialize for frontend: convert Date to ISO string
            const serialized = processedMessages.map((m: any) => ({
                ...m,
                timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp
            }));
            logger.debug("Socket", `Emitting message.update for ${serialized.length} messages in session ${sessionId}`);
            io?.to(sessionId).emit('message.update', serialized);
        }
    });

    // Handle Message History Sync (when connecting for the first time or syncing)
    sock.ev.on('messaging-history.set', async ({ messages, chats, contacts, isLatest }) => {
        logger.info("Store", `History sync: ${messages?.length || 0} messages, ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, latest: ${isLatest}`);

        // Ensure we have the database session ID
        if (!dbSessionId) {
            const session = await prisma.session.findUnique({ where: { sessionId }, select: { id: true } });
            if (!session) return;
            dbSessionId = session.id;
        }

        // Save all historical messages
        if (messages && messages.length > 0) {
            logger.info("Store", `Syncing ${messages.length} historical messages...`);
            for (const msg of messages) {
                try {
                    await processAndSaveMessage(msg, dbSessionId, sessionId, false, sock, undefined, io);
                } catch (error) {
                    logger.error("Store", "Error saving historical message", error);
                }
            }
            logger.success("Store", `Finished syncing ${messages.length} historical messages`);
        }


        // Note: Contacts and Chats are synced by src/modules/whatsapp/store/contacts.ts
        // We only handle messages here to avoid P2002 Unique Constraint Race Conditions.
        logger.debug("Store", `Finished syncing messages`);
    });

    // Handle Contacts Upsert
    sock.ev.on('contacts.upsert', async (contacts) => {
        // Ensure we have the database session ID
        if (!dbSessionId) {
            const session = await prisma.session.findUnique({ where: { sessionId }, select: { id: true } });
            if (!session) return;
            dbSessionId = session.id;
        }

        for (const c of contacts) {
            try {
                if (!c.id) continue;
                // Baileys 7 often delivers contacts keyed by their LID (privacy id, "1234…@lid"), not by
                // phone number. A LID is useless as a contact row (no number, name "Unknown", cannot be
                // messaged from a list), so resolve it to the phone JID first and skip it if that fails.
                const cAny = c as unknown as { phoneNumber?: string };
                let contactJidResolved: string | null = null;
                if (!isLidJid(c.id)) contactJidResolved = normalizeJid(c.id);
                else if (cAny.phoneNumber && !isLidJid(cAny.phoneNumber)) contactJidResolved = normalizeJid(cAny.phoneNumber);
                else contactJidResolved = await lidToPhoneJidViaSocket(sock, c.id);
                if (!contactJidResolved) {
                    logger.debug("Store", `contacts.upsert: no phone number known for ${c.id}, skipped`);
                    continue;
                }
                const lidValue = isLidJid(c.id) ? c.id : (c.lid || undefined);
                await prisma.contact.upsert({
                    where: { sessionId_jid: { sessionId: dbSessionId, jid: contactJidResolved } },
                    create: {
                        sessionId: dbSessionId,
                        jid: contactJidResolved,
                        // @ts-ignore
                        lid: lidValue,
                        name: c.name || c.notify || c.verifiedName,
                        notify: c.notify,
                        // @ts-ignore
                        verifiedName: c.verifiedName,
                        profilePic: c.imgUrl || undefined,
                        data: c as any
                    },
                    update: {
                        // @ts-ignore
                        lid: lidValue,
                        name: c.name || undefined,
                        notify: c.notify || undefined,
                        // @ts-ignore
                        verifiedName: c.verifiedName || undefined,
                        profilePic: c.imgUrl || undefined,
                        data: c as any
                    }
                });

                // Dispatch webhook for contact update
                dispatchWebhook(sessionId, "contact.update", { jid: contactJidResolved, lid: lidValue, name: c.name, notify: c.notify });
            } catch (e) {
                logger.error("Store", "Error saving contact", e);
            }
        }
    });

    // Handle Message Status Updates
    sock.ev.on('messages.update', async (updates) => {
        if (!dbSessionId) return;

        for (const update of updates) {
            try {
                const keyId = update.key?.id;
                if (!keyId) continue;

                const statusMap: Record<number, string> = {
                    0: 'PENDING',
                    1: 'SENT',
                    2: 'DELIVERED',
                    3: 'READ',
                    4: 'READ', // Played
                };

                const status = statusMap[update.update?.status || 0] || 'PENDING';

                await prisma.message.updateMany({
                    where: { sessionId: dbSessionId, keyId },
                    data: { status: status as any }
                });

                // Broadcast engagement tracking: receipts for messages the broadcast engine sent
                if (status === 'DELIVERED' || status === 'READ') {
                    const now = new Date();
                    prisma.broadcastRecipient.updateMany({
                        where: {
                            messageId: keyId,
                            // never downgrade READ back to DELIVERED
                            ...(status === 'DELIVERED' ? { OR: [{ deliveryStatus: null }, { deliveryStatus: 'SENT' }] } : {})
                        },
                        data: status === 'READ'
                            ? { deliveryStatus: 'READ', readAt: now, deliveredAt: undefined }
                            : { deliveryStatus: 'DELIVERED', deliveredAt: now }
                    }).then(async (r) => {
                        // READ implies delivered — fill deliveredAt if it was never set
                        if (status === 'READ' && r.count > 0) {
                            await prisma.broadcastRecipient.updateMany({ where: { messageId: keyId, deliveredAt: null }, data: { deliveredAt: now } }).catch(() => {});
                        }
                    }).catch(() => {});
                }

                // Dispatch webhook for message status update
                dispatchWebhook(sessionId, "message.status", {
                    keyId,
                    remoteJid: update.key?.remoteJid,
                    status
                });
            } catch (e) {
                logger.error("Store", "Error updating message status", e);
            }
        }
    });

    // Handle Group Updates
    sock.ev.on('groups.update', async (updates) => {
        if (!dbSessionId) return;

        for (const update of updates) {
            try {
                if (!update.id) continue;
                
                // Keep DB in sync
                const updateData: any = {};
                if (update.subject !== undefined) updateData.subject = update.subject;
                if (update.desc !== undefined) updateData.description = update.desc;
                if (update.restrict !== undefined) updateData.restrict = update.restrict;
                if (update.announce !== undefined) updateData.announce = update.announce;
                if (update.owner !== undefined) updateData.ownerJid = update.owner;
                if (update.linkedParent !== undefined) updateData.linkedParentJid = update.linkedParent;
                if (update.isCommunity !== undefined) updateData.isCommunity = update.isCommunity;

                if (Object.keys(updateData).length > 0) {
                    await prisma.group.updateMany({
                        where: { sessionId: dbSessionId, jid: update.id },
                        data: updateData
                    });
                }
                
                // Trigger webhook
                dispatchWebhook(sessionId, "group.update", {
                    jid: update.id,
                    ...update
                });
            } catch (e) {
                logger.error("Store", "Error in groups.update handling", e);
            }
        }
    });

    // Handle Group Participants Update
    sock.ev.on('group-participants.update', async (update) => {
        if (!dbSessionId || !update.id) return;

        try {
            // update.id is the group JID
            // update.participants is array of JIDs
            // update.action is 'add', 'remove', 'promote', 'demote'
            dispatchWebhook(sessionId, "group.participant", {
                jid: update.id,
                action: update.action,
                participants: update.participants
            });
            
            // To properly resync the group participants in DB, it's safer to re-fetch the entire group metadata
            // But we don't await strictly to not block the socket
            sock.groupMetadata(update.id).then(async (g) => {
                await prisma.group.updateMany({
                    where: { sessionId: dbSessionId as string, jid: update.id as string },
                    data: { participants: g.participants as any }
                });
            }).catch(e => {
                 logger.debug("Store", "Failed to refresh group participants metadata", e);
            });
        } catch (e) {
            logger.error("Store", "Error in group-participants.update handling", e);
        }
    });
};

async function processAndSaveMessage(
    msg: WAMessage,
    dbSessionId: string,
    sessionId: string,
    triggerWebhook: boolean,
    sock?: WASocket,
    config?: any,
    io?: Server | null
) {
    const keyId = msg.key.id;
    const remoteJid = msg.key.remoteJid;
    const fromMe = msg.key.fromMe;
    const pushName = msg.pushName;
    const timestamp = msg.messageTimestamp
        ? new Date((typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Number(msg.messageTimestamp)) * 1000)
        : new Date();

    // Filter out Protocol & Empty Messages
    if (!msg.message) return false;
    if (!keyId || !remoteJid) return false;

    // Ignore specific technical message types
    const messageKeys = Object.keys(msg.message);

    // Check for message edit/revoke protocol messages FIRST
    if (messageKeys.includes('protocolMessage')) {
        const pMessage = msg.message.protocolMessage;
        const targetKeyId = pMessage?.key?.id;

        // Message Edit (Type 14)
        if (pMessage?.type === 14 && targetKeyId) {
            const editContent = pMessage?.editedMessage;
            if (editContent) {
                // Determine new text
                const normalizedEdit = normalizeMessageContent(editContent);
                let newText = "";
                if (normalizedEdit?.conversation) newText = normalizedEdit.conversation;
                else if (normalizedEdit?.extendedTextMessage?.text) newText = normalizedEdit.extendedTextMessage.text;

                // Update DB safely
                await prisma.message.updateMany({
                    where: { sessionId: dbSessionId, keyId: targetKeyId },
                    data: { content: newText } // Note: we don't update timestamp of original
                });

                // Trigger Webhook
                if (triggerWebhook) {
                    dispatchWebhook(sessionId, "message.edited", {
                        keyId: targetKeyId,
                        newContent: newText,
                        remoteJid,
                        fromMe
                    });
                }
            }
            return null; // Stop processing as new message
        }

        // Message Revoke/Deleted (Type 0)
        if (pMessage?.type === 0 && targetKeyId) {
            // Check anti-delete config
            let antiDeleteEnabled = false;
            try {
                const s = await prisma.session.findUnique({
                    where: { sessionId },
                    select: { config: true }
                });
                antiDeleteEnabled = !!(s?.config as any)?.antiDelete;
            } catch {}

            if (antiDeleteEnabled) {
                // Anti-delete: read original, keep content, append marker
                const orig = await prisma.message.findFirst({
                    where: { sessionId: dbSessionId, keyId: targetKeyId },
                    select: { content: true }
                });
                const preserved = (orig?.content || "") + "\n\n🛡️ [Deleted by sender — preserved]";
                await prisma.message.updateMany({
                    where: { sessionId: dbSessionId, keyId: targetKeyId },
                    data: { content: preserved }
                });
                // Re-fetch & re-emit so frontend updates
                const updated = await prisma.message.findFirst({
                    where: { sessionId: dbSessionId, keyId: targetKeyId }
                });
                if (updated) {
                    io?.to(sessionId).emit("message.update", [{
                        ...updated,
                        timestamp: updated.timestamp instanceof Date ? updated.timestamp.toISOString() : updated.timestamp
                    }]);
                }
            } else {
                // Normal: mark as deleted
                await prisma.message.updateMany({
                    where: { sessionId: dbSessionId, keyId: targetKeyId },
                    data: { content: "[This message was deleted]", status: "FAILED" }
                });
            }

            // Trigger Webhook
            if (triggerWebhook) {
                dispatchWebhook(sessionId, "message.deleted", {
                    keyId: targetKeyId,
                    remoteJid,
                    fromMe
                });
            }
            return null;
        }
    }

    const ignoredTypes = [
        'protocolMessage',
        'senderKeyDistributionMessage',
        'reactionMessage', // Optional: User might want reactions, but usually "kosong" means junk
        'keepInChatMessage'
    ];

    // If message only contains ignored types, skip (since edit and revoke handled above)
    if (messageKeys.every(k => ignoredTypes.includes(k))) {
        logger.debug("Store", `Skipping technical message: ${keyId} (${messageKeys.join(', ')})`);
        return null;
    }

    // Check if message already exists to avoid duplicates
    // Baileys 'notify' event can sometimes trigger multiple times or for history
    // Baileys 'notify' event can sometimes trigger multiple times or for history
    const existingMessage = await prisma.message.findUnique({
        where: { sessionId_keyId: { sessionId: dbSessionId, keyId: keyId! } },
        select: { id: true, status: true }
    });

    if (existingMessage) {
        // Message exists! Update status if changed, but DO NOT re-trigger webhooks/bot
        if (fromMe && existingMessage.status !== 'SENT') {
            await prisma.message.update({
                where: { id: existingMessage.id },
                data: { status: 'SENT' }
            });
        }
        // Return null to indicate "Not New"
        return null;
    }

    // Debug fromMe issue (Keep this for a while)
    if (fromMe === undefined || fromMe === null) {
        logger.warn("Store", `[DEBUG] Message ${keyId} has fromMe=${fromMe}. Key:`, msg.key);
    }

    const messageContent = normalizeMessageContent(msg.message);
    let text = "";
    let messageType = "TEXT";

    // Extract content based on message type
    if (messageContent?.conversation) {
        text = messageContent.conversation;
    } else if (messageContent?.extendedTextMessage?.text) {
        text = messageContent.extendedTextMessage.text;
    } else if (messageContent?.imageMessage) {
        messageType = "IMAGE";
        text = messageContent.imageMessage.caption || "";
    } else if (messageContent?.videoMessage) {
        messageType = "VIDEO";
        text = messageContent.videoMessage.caption || "";
    } else if (messageContent?.audioMessage) {
        messageType = "AUDIO";
    } else if (messageContent?.documentMessage) {
        messageType = "DOCUMENT";
        text = messageContent.documentMessage.fileName || "";
    } else if (messageContent?.stickerMessage) {
        messageType = "STICKER";
    } else if (messageContent?.locationMessage) {
        messageType = "LOCATION";
        text = `${messageContent.locationMessage.degreesLatitude},${messageContent.locationMessage.degreesLongitude}`;
    } else if (messageContent?.contactMessage) {
        messageType = "CONTACT";
        text = messageContent.contactMessage.displayName || "";
    }

    // Determine effective participant for groups
    // Determine effective participant for groups with standard logic
    const isGroup = remoteJid.endsWith("@g.us");
    const remoteJidAlt = msg.key.remoteJidAlt; // LID/Phone JID handling
    let senderJid = fromMe ? undefined : (isGroup ? (msg.key.participant || msg.participant) : remoteJid);

    // Prefer remoteJidAlt for DMs if available (matches webhook logic)
    if (!fromMe && !isGroup && remoteJidAlt) {
        senderJid = remoteJidAlt;
    }

    // --- Normalize LID JIDs to @s.whatsapp.net ---
    let normalizedRemoteJid = remoteJid;
    if (isLidJid(remoteJid)) {
        normalizedRemoteJid = await resolveToPhoneJid(remoteJid, dbSessionId, remoteJidAlt);
        if (isLidJid(normalizedRemoteJid)) normalizedRemoteJid = (await lidToPhoneJidViaSocket(sock, remoteJid)) || normalizedRemoteJid;
    }
    if (senderJid && isLidJid(senderJid)) {
        senderJid = await resolveToPhoneJid(senderJid, dbSessionId, remoteJidAlt);
        if (isLidJid(senderJid)) senderJid = (await lidToPhoneJidViaSocket(sock, senderJid)) || senderJid;
    }


    // Download Media First (to save URL to DB)
    let fileUrl: string | null = null;
    try {
        fileUrl = await downloadAndSaveMedia(msg, sessionId);
    } catch (e) {
        logger.error("Store", "Error downloading media in store", e);
    }

    // Extract contextInfo (quoted message ID)
    let quoteId: string | null = null;
    if (msg.message) {
        const msgObj = msg.message as any;
        for (const key of Object.keys(msgObj)) {
            const inner = msgObj[key];
            if (inner && typeof inner === 'object' && inner !== null && 'contextInfo' in inner) {
                const contextInfo = (inner as any).contextInfo;
                if (contextInfo?.stanzaId) {
                    quoteId = contextInfo.stanzaId;
                    break;
                }
            }
        }
    }

    try {
        const newMessage = await prisma.message.create({
            data: {
                sessionId: dbSessionId,
                remoteJid: normalizeJid(normalizedRemoteJid),
                senderJid,
                fromMe: fromMe || false,
                keyId,
                pushName,
                type: messageType as any,
                content: text,
                mediaUrl: fileUrl, // Save Media URL
                status: fromMe ? "SENT" : "PENDING",
                timestamp,
                quoteId
            }
        });
        
        // Ensure contact exists (Upsert Contact)
        const finalRemoteJid = normalizeJid(normalizedRemoteJid);
        // No contact row for an unresolved LID: it has no phone number and would show up as "Unknown".
        if (remoteJid && !remoteJid.includes('@g.us') && !remoteJid.includes('status@broadcast') && !isLidJid(finalRemoteJid)) {
            const contactJid = finalRemoteJid; // Use fully normalized JID
            const contactData: any = {
                sessionId: dbSessionId,
                jid: contactJid
            };

            // Only update name/notify if message is FROM the contact (not from me)
            if (!fromMe) {
                if (pushName) contactData.notify = pushName;
                if (pushName) contactData.name = pushName;
            }

            const contact = await prisma.contact.upsert({
                where: { sessionId_jid: { sessionId: dbSessionId, jid: contactJid } },
                create: {
                    sessionId: dbSessionId,
                    jid: contactJid,
                    notify: !fromMe ? pushName : undefined,
                    name: !fromMe ? pushName : undefined,
                    // @ts-ignore
                    remoteJidAlt: remoteJidAlt || undefined
                },
                update: !fromMe ? {
                    notify: pushName,
                    // @ts-ignore
                    remoteJidAlt: remoteJidAlt || undefined
                } : {}
            });

            // Broadcast engagement: a reply from someone we broadcast to in the last 72h
            if (!fromMe && triggerWebhook) {
                const since = new Date(Date.now() - 72 * 3600 * 1000);
                prisma.broadcastRecipient.updateMany({
                    where: {
                        jid: { in: Array.from(new Set([finalRemoteJid, remoteJid, remoteJidAlt || ""].filter(Boolean))) },
                        status: "sent",
                        repliedAt: null,
                        sentAt: { gte: since },
                        broadcastLog: { sessionId }
                    },
                    data: { repliedAt: new Date() }
                }).catch(() => {});
            }

            // Welcome Message Logic
            if (!fromMe && triggerWebhook && config?.welcomeMessage && sock) {
                // Let's check if message count for this contact is exactly 1 (the one we just saved)
                const msgCount = await prisma.message.count({
                    where: { sessionId: dbSessionId, remoteJid: finalRemoteJid }
                });

                if (msgCount === 1) {
                    logger.info("Store", `Sending welcome message to ${finalRemoteJid}`);
                    await sock.sendMessage(finalRemoteJid, { text: config.welcomeMessage });
                }
            }
        }

        // Trigger webhook for new messages only (not history sync)
        if (triggerWebhook) {
            if (fromMe) {
                onMessageSent(sessionId, msg, fileUrl).catch(e => logger.error("Webhook", "Error in onMessageSent", e));
            } else {
                onMessageReceived(sessionId, msg, fileUrl).catch(e => logger.error("Webhook", "Error in onMessageReceived", e));
            }
        }

        return newMessage;
    } catch (e: any) {
        logger.error("Store", "Error saving message query", e);
        throw e;
    }
}
// Placeholder - verified that I need to find the logic first


/**
 * One-off repair for contact rows that were created with a LID as their jid ("…@lid"). For each
 * one, ask Baileys for the phone number; when known, merge the row into the phone-number contact
 * (keeping the name) and delete the LID row. Rows that cannot be resolved are left (the Contacts
 * API hides them). Runs after every successful connect; cheap when there is nothing to do.
 */
export async function mergeLidContacts(sock: WASocket, sessionId: string): Promise<{ merged: number; unresolved: number }> {
    const session = await prisma.session.findUnique({ where: { sessionId }, select: { id: true } });
    if (!session) return { merged: 0, unresolved: 0 };
    const lidRows = await prisma.contact.findMany({
        where: { sessionId: session.id, jid: { endsWith: "@lid" } },
        select: { id: true, jid: true, name: true, notify: true, verifiedName: true, profilePic: true, optedOut: true, optedOutAt: true }
    });
    let merged = 0, unresolved = 0;
    for (const row of lidRows) {
        try {
            const pn = await lidToPhoneJidViaSocket(sock, row.jid);
            if (!pn) { unresolved++; continue; }
            await prisma.contact.upsert({
                where: { sessionId_jid: { sessionId: session.id, jid: pn } },
                create: {
                    sessionId: session.id, jid: pn,
                    // @ts-ignore
                    lid: row.jid,
                    name: row.name || undefined, notify: row.notify || undefined,
                    // @ts-ignore
                    verifiedName: row.verifiedName || undefined, profilePic: row.profilePic || undefined,
                    optedOut: row.optedOut, optedOutAt: row.optedOutAt || undefined
                },
                update: {
                    // @ts-ignore
                    lid: row.jid,
                    ...(row.name ? { name: row.name } : {}),
                    ...(row.notify ? { notify: row.notify } : {}),
                    ...(row.optedOut ? { optedOut: true, optedOutAt: row.optedOutAt || new Date() } : {})
                }
            });
            await prisma.message.updateMany({ where: { sessionId: session.id, remoteJid: row.jid }, data: { remoteJid: pn } }).catch(() => {});
            await prisma.message.updateMany({ where: { sessionId: session.id, senderJid: row.jid }, data: { senderJid: pn } }).catch(() => {});
            await prisma.contact.delete({ where: { id: row.id } });
            merged++;
        } catch (e) {
            logger.debug("Store", `mergeLidContacts: could not merge ${row.jid}`, e);
            unresolved++;
        }
    }
    if (lidRows.length > 0) logger.info("Store", `LID contacts for ${sessionId}: ${merged} merged into phone contacts, ${unresolved} still unresolved (hidden)`);
    return { merged, unresolved };
}
