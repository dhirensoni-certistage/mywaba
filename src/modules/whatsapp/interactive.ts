import {
    generateWAMessageFromContent,
    prepareWAMessageMedia,
    proto,
    type WASocket,
    type AnyMessageContent
} from "@whiskeysockets/baileys";
import { antispam } from "./antispam";

/**
 * Interactive (button) messages — BETA.
 *
 * Baileys 7 has no public API for buttons; WhatsApp only guarantees them for the official
 * Business Platform. This sends a raw `interactiveMessage` with native-flow buttons, which
 * renders on most Android clients, less reliably on iOS and WhatsApp Web. Treat it as
 * best-effort: the broadcast UI labels it Beta, and the engine falls back to plain text if
 * the interactive send throws.
 */

export type BroadcastButton =
    | { type: "reply"; text: string }
    | { type: "url"; text: string; url: string }
    | { type: "call"; text: string; phone: string };

export const MAX_BUTTONS = 3;

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

/**
 * Send text (or image/video/document + caption) with up to three buttons.
 * Goes through the anti-spam queue like every other outgoing message.
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

    const message = proto.Message.create({
        viewOnceMessage: proto.Message.FutureProofMessage.create({
            message: proto.Message.create({ interactiveMessage: interactive })
        })
    });

    const userJid = sock.user?.id || "";
    const waMessage = generateWAMessageFromContent(jid, message, { userJid });

    await antispam.enqueue(sessionId, jid, { text: bodyText });
    await sock.relayMessage(jid, waMessage.message!, { messageId: waMessage.key.id! });
    return waMessage;
}
