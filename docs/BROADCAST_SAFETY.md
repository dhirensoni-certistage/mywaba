# Broadcast Safety & Number Protection

WhatsApp does not offer bulk messaging on personal/business numbers through Baileys. Every
broadcast is a series of normal chat messages, and WhatsApp's anti-spam system judges them the
same way it judges a human: by volume, speed, repetition, recipient reaction and whether the
recipients know you.

When it decides a device is spamming, the first step is usually to **force-unlink the linked
device** (the gateway receives disconnect code `401` with `device_removed`). The session shows as
LOGGED OUT and every remaining send fails. Repeated flags lead to a **temporary ban** of the number
(hours to days) and then a **permanent ban**.

## What the engine does for you

| Protection | Default | Why |
|---|---|---|
| Number validation (`onWhatsApp`) | on | Sending to numbers that are not on WhatsApp is one of the strongest spam signals. Invalid numbers are skipped, not sent. |
| Minimum delay | 3 s (8 s default) | Human-like pacing. Random jitter of up to +60% is added so intervals are never identical. |
| Batch cooldown | 20 messages, then 60–90 s | Mimics natural pauses; keeps the per-minute rate low. |
| Typing simulation | on | Presence "composing" before each message, proportional to text length. |
| Auto-abort | always | If the session disconnects the engine waits up to 2 min for a reconnect, then stops and records the reason. 5 consecutive failures also stop the run. |
| Max recipients | 500 per broadcast | Forces large lists to be split over time. |
| Daily limit | 200 / rolling 24h | Hard cap per session (Bot Settings → Broadcast Safety). A run that would exceed it is refused before anything is sent. |
| Quiet hours | off (recommended 10 PM – 8 AM) | Sends pause inside the window, in the system timezone. |
| Opt-out | on, keywords STOP / UNSUBSCRIBE / STOP ALL / CANCEL | A contact who replies with a keyword is flagged and skipped by every future broadcast; optional confirmation reply. |
| Personalisation | `{name}`, `{name|fallback}`, `{a|b|c}` | Every message differs; identical texts are a spam signal. |
| Random order | on | Sequential number blocks are not hit in order. |
| Cancel | Stop button | Stop a run the moment you see failures. |

These defaults reduce risk; they cannot make unsolicited bulk messaging safe.

The same guide is available inside the dashboard: **Broadcast → Safety Guide** tab (visible to every role, including staff).

## Volume guidance (conservative, from community experience)

| Number age | Cold recipients / day | Notes |
|---|---|---|
| New number (first 2–3 weeks) | 20–50 | "Warm up": chat normally, join groups, reply to people first. |
| Warmed-up number | 100–200 | Spread across the day, not in one run. |
| Number with established 2-way chats | 200–500 | Only to people who have replied to you before. |

"Cold" means the recipient has never messaged you. Messages to contacts who have replied before are
far safer. Messages to numbers that are **not saved in the phone's contacts** carry more weight.

## Content rules of thumb

- Personalise: include the recipient's name or a detail; avoid 100 byte-identical texts.
- Avoid link shorteners and more than one link per message. Prefer your own domain.
- Do not send media + text as two separate messages per recipient; use a caption.
- Keep the first message short and make it easy to reply ("Reply STOP to opt out" helps).
- Never message people who did not give you their number or opt in.

## Operational rules

- Use a dedicated number for broadcasting, not your main business line.
- Keep the phone online with a stable connection and the WhatsApp app updated.
- If a run gets logged out: **stop for 24 hours**, re-link, and resume with half the volume.
- If you see "Forbidden (403)" on reconnect, the number is restricted — wait, do not keep retrying.
- Check the **History → Detail** view: the error column tells you exactly why each recipient failed.
- For genuinely large, promotional campaigns use the official **WhatsApp Business Platform (Cloud API)**
  with pre-approved templates. That is the only sanctioned way to do bulk outreach.

## Reading failures

| Error text | Meaning | What to do |
|---|---|---|
| `Number is not registered on WhatsApp — skipped` | Validation failed for this number. | Clean your list. |
| `Session was logged out by WhatsApp` | 401 device_removed during the run. | Re-link, wait 24h, lower volume. |
| `Session did not reconnect in time` | Network/phone offline > 2 min. | Check the phone and server network. |
| `Aborted after 5 consecutive failures` | Circuit breaker. | Inspect the last error; usually connection loss. |
| `Recipient opted out (replied STOP) — skipped` | Contact is flagged as opted out. | Respect it. Clear the flag in the database only if they re-subscribe. |
| `Daily send limit of N reached` | Session hit its 24h budget mid-run. | Continue tomorrow, or raise the limit deliberately. |
| `Cancelled by user` | You pressed Stop. | — |
| `Server restarted while broadcast was running` | PM2/VPS restart mid-run. | Re-send to the remaining recipients only. |
