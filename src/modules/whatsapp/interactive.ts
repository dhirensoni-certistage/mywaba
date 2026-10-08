import {
    generateWAMessageFromContent,
    prepareWAMessageMedia,
    proto,
    isJidGroup,
    type WASocket,
    type AnyMessageContent,
    type BinaryNode
} from "@whiskeysockets/baileys";
import { antispam } from "./antispam";

/**
 * Interactive (button) messages — BETA.
 *
 * Baileys 7 has no public API for buttons; WhatsApp only guarantees them for the official
 * Business Platform. This sends a raw `interactiveMessage` with native-flow buttons.
 *
 * Rendering depends on the stanza, not only on the protobuf: official clients send interactive
 * messages with extra binary nodes (`<biz><interactive type="native_flow"><native_flow …/></interactive></biz>`
 * plus `<bot biz_bot="1"/>` in 1:1 chats). Without them the receiving phone accepts the message
 * but shows nothing at all — which is exactly what happened before: "sent" in History, invisible
 * on the target phone. The nodes are passed through `relayMessage({ additionalNodes })`.
 *
 * It is still best-effort (iPhone / Web render fewer of them), so the engine also offers
 * `buttonMode: "text"` — the buttons are appended as plain lines that every client shows —
 * and uses that automatically when WhatsApp rejects the interactive message.
 */

export type BroadcastButton =
    | { type: "reply"; text: string }
    | { type: "url"; text: string; url: string }
    | { type: "call"; text: string; phone: string };

export const MAX_BUTTONS = 3;

/*
 * Ban risk of `buttonMode: "interactive"`: the stanza nodes that make the buttons render
 * (`biz/interactive/native_flow`, `bot biz_bot=1`) declare the message as coming from a business
 * bot. WhatsApp accepts every single one of them (so the send never fails and the text fallback
 * never triggers), then force-unlinks a normal linked device that sends them in bulk: 401
 * `device_removed` after a few dozen messages, seen in production at ~40. There is no per-run
 * cap by the owner's choice; "text" is the default and the UI warns.
 */

export function sanitizeButtons(input: unknown): BroadcastButton[] {
    if (!Array.isArray(input)) return [];
    const out: BroadcastButton[] = [];
    for (const raw of input) {
        if (!raw || typeof raw !== "object") continue;
        const b = raw as Record<string, unknown>;
        const text = String(b.text ?? "").trim().slice(0, 25);
        if (!text) continue;
        const type = String(b.type ?? "reply");
        if (type === "url") {
            const url = String(b.url ?? "").trim();
            if (!/^https?:\/\//i.test(url)) continue;
            out.push({ type: "url", text, url: url.slice(0, 500) });
        } else if (type === "call") {
            const phone = String(b.phone ?? "").replace(/[^0-9+]/g, "");
            if (phone.replace(/\D/g, "").length < 7) continue;
            out.push({ type: "call", text, phone });
        } else {
            out.push({ type: "reply", text });
        }
        if (out.length >= MAX_BUTTONS) break;
    }
    return out;
}

function toNativeFlowButtons(buttons: BroadcastButton[], idPrefix: string) {
    return buttons.map((b, i) => {
        if (b.type === "url") {
            return { name: "cta_url", buttonParamsJson: JSON.stringify({ display_text: b.text, url: b.url, merchant_url: b.url }) };
        }
        if (b.type === "call") {
            return { name: "cta_call", buttonParamsJson: JSON.stringify({ display_text: b.text, phone_number: b.phone }) };
        }
        return { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: b.text, id: `${idPrefix}_${i + 1}` }) };
    });
}

export type ButtonMode = "interactive" | "text";

/**
 * Binary nodes WhatsApp clients attach to native-flow messages. Without them the recipient's
 * phone drops the message silently.
 */
function interactiveNodes(jid: string): BinaryNode[] {
    const nodes: BinaryNode[] = [{
        tag: "biz",
        attrs: {},
        content: [{
            tag: "interactive",
            attrs: { type: "native_flow", v: "1" },
            content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }]
        }]
    }];
    if (!isJidGroup(jid)) nodes.push({ tag: "bot", attrs: { biz_bot: "1" } });
    return nodes;
}

/** The buttons as plain text lines — what every client can display. */
export function buttonsAsText(buttons: BroadcastButton[], footer?: string): string {
    const lines = buttons.map(b => {
        if (b.type === "url") return `🔗 ${b.text}: ${b.url}`;
        if (b.type === "call") return `📞 ${b.text}: ${b.phone}`;
        return `👉 Reply *${b.text}*`;
    });
    if (footer) lines.push(`_${footer}_`);
    return lines.join("\n");
}

/** Append the buttons as text lines to a text message or a media caption. */
export function appendButtonsAsText(content: AnyMessageContent, buttons: BroadcastButton[], footer?: string): AnyMessageContent {
    if (buttons.length === 0) return content;
    const extra = buttonsAsText(buttons, footer);
    const c: Record<string, unknown> = { ...content };
    if (typeof c.text === "string") c.text = c.text.trim() ? `${c.text}\n\n${extra}` : extra;
    else c.caption = typeof c.caption === "string" && c.caption.trim() ? `${c.caption}\n\n${extra}` : extra;
    return c as unknown as AnyMessageContent;
}

/**
 * Send text (or image/video/document + caption) with up to three buttons as a native-flow
 * interactive message. Goes through the anti-spam queue like every other outgoing message.
 */
export async function sendInteractiveMessage(
    sock: WASocket,
    sessionId: string,
    jid: string,
    content: AnyMessageContent,
    buttons: BroadcastButton[],
    footer?: string
) {
    const anyContent = content as any;
    const bodyText: string = anyContent.text ?? anyContent.caption ?? "";

    // Header: optional media (uploaded once per recipient — Baileys caches by content hash)
    let header: proto.Message.InteractiveMessage.IHeader = { hasMediaAttachment: false };
    const mediaKey = (["image", "video", "document"] as const).find(k => anyContent[k] !== undefined);
    if (mediaKey) {
        const mediaContent: any = { [mediaKey]: anyContent[mediaKey] };
        if (anyContent.mimetype) mediaContent.mimetype = anyContent.mimetype;
        if (anyContent.fileName) mediaContent.fileName = anyContent.fileName;
        const prepared = await prepareWAMessageMedia(mediaContent, { upload: sock.waUploadToServer, logger: (sock as any).logger });
        header = {
            hasMediaAttachment: true,
            imageMessage: prepared.imageMessage ?? undefined,
            videoMessage: prepared.videoMessage ?? undefined,
            documentMessage: prepared.documentMessage ?? undefined
        };
    }

    const interactive = proto.Message.InteractiveMessage.create({
        header: proto.Message.InteractiveMessage.Header.create(header),
        body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
        footer: footer ? proto.Message.InteractiveMessage.Footer.create({ text: footer }) : undefined,
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: toNativeFlowButtons(buttons, "btn"),
            messageParamsJson: JSON.stringify({})
        })
    });

    // Sent un-wrapped (not inside viewOnceMessage) with the device-list context official clients
    // include; the rendering-critical part is the `additionalNodes` on the stanza below.
    const message = proto.Message.create({
        messageContextInfo: proto.MessageContextInfo.create({ deviceListMetadata: {}, deviceListMetadataVersion: 2 }),
        interactiveMessage: interactive
    });

    const userJid = sock.user?.id || "";
    const waMessage = generateWAMessageFromContent(jid, message, { userJid });

    await antispam.enqueue(sessionId, jid, { text: bodyText });
    await sock.relayMessage(jid, waMessage.message!, { messageId: waMessage.key.id!, additionalNodes: interactiveNodes(jid) });
    return waMessage;
}
