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

## Sending more without raising the risk per number

The daily limit is **per WhatsApp number**, and it is adjustable (Bot Settings → Broadcast Safety, or the
"Set" box in Number Health; `0` disables it). Raising it on a single number raises the ban risk on that
number. The approaches that scale safely are:

| Approach | Where | Effect |
|---|---|---|
| **Spread evenly over N hours** | Broadcast → "Spread evenly over (hours)" | 500 recipients over 10 hours = one message every ~70 s, which reads like a person chatting all day. Replaces the batch rhythm. |
| **Send from several numbers** | Broadcast → "Also send from other connected numbers" | The list is split round-robin across the selected connected sessions and sent in parallel. Each number keeps its own daily limit and history. 4 warmed-up numbers × 200 = 800/day. |
| **Personalise every message** | `{name}`, `{city}`, `{a|b}` | Different texts per recipient; identical texts are the strongest content signal. |
| **Only warm audiences** | your list | Recipients who have replied before carry far less weight than cold numbers. |

Do not: shorten the minimum delay (it is 3 s on purpose), run the same list from the same number twice
a day, or use freshly bought SIMs for volume — they are flagged within hours.

## Excel / CSV upload

Upload a `.xlsx` or `.csv` on the Broadcast page. The first row must be a header. Required: a column
named `phone`, `number`, `mobile`, `whatsapp` or `contact` with the full international number
(`919876543210`). Optional: `name`. **Every column becomes a placeholder**: a column `city` can be used
as `{city}` or `{city|your area}` in the message or caption. Numbers not on WhatsApp are still validated
and skipped at send time. Max 5000 rows per file, 500 recipients per number per run.

## Number check before sending

Pressing **Start** first validates the whole list (paged, cached per session for 24 h) and opens a
summary: uploaded / on WhatsApp / not on WhatsApp or invalid / opted out, with the full list of
problem numbers (copyable). **Remove N & keep M** drops them from the list; **Start anyway** lets the
engine skip them at send time. The same check is available any time via **Check numbers**.

## Retry failed

History → Detail → **Retry failed (N)** starts a new run with the same message, media, buttons and
pacing for the recipients that failed for a *temporary* reason (connection lost, logout, cancelled,
daily limit, server restart, send error). Numbers that are not on WhatsApp or opted out are never
retried. Per-recipient variables are preserved, so `{name}` still works. The daily limit applies.

## Alerts

Settings → Alerts (superadmin): Telegram (bot token + chat id, no server change) and/or email
(`SMTP_*` in `.env`). Alerts fire for: session logged out or auto-stopped (with the WhatsApp reason),
a broadcast that stopped or had delivery failures, and a number reaching 80% / 100% of its daily
limit. Identical alerts are suppressed for 5 minutes. **Send Test Alert** verifies the channel.

## Warm-up mode

Bot Settings → Broadcast Safety → **Warm-up mode**. While on, the daily cap ramps automatically:
days 1–3 → 20, 4–7 → 50, 8–14 → 100, 15–21 → 150, afterwards your daily limit (the lower of the two
always wins). Turn it on for every new number and after every WhatsApp logout; **Restart** sets it
back to day 1. During warm-up the number should also be used normally (chats, replies, groups).

## Delivery & engagement monitoring

Every broadcast message is tracked through WhatsApp receipts: `deliveryStatus` SENT → DELIVERED → READ,
and `repliedAt` when the recipient writes back within 72 h. Number Health shows delivered / read /
replied / "undelivered > 10 min" for the last 7 days and 24 h; History shows the same per broadcast.

- **Auto-pause (delivery collapse)**: during a run, every 20 sends the engine looks at messages sent
  more than 10 minutes ago. If at least 30 exist and 70 % or more still have a single tick, the run
  stops, broadcasting on that number is paused for 12 hours (`BotConfig.broadcastPausedUntil`) and an
  alert is sent. Single ticks at that scale mean WhatsApp is holding the messages or recipients are
  blocking the number. Owners can "Resume anyway" from Number Health; do not resume with the same list.
- **Low engagement warning**: every 30 minutes a monitor checks connected sessions; 100+ sends in
  24 h with under 1 % replies produces one alert per day.
- Healthy numbers: delivered above ~85 %, undelivered under ~30 %, replies above 1–2 % on warm lists.

## Buttons (BETA)

Quick-reply, link and call buttons (max 3) can be attached on the Broadcast page, in one of two modes
(**Send as**):

- **Interactive buttons** — a native-flow "interactive message". WhatsApp supports these officially only
  on the Business Platform API. From a linked device most Android phones render them; iPhone and
  WhatsApp Web often do not — and a client that does not support them shows **nothing at all**, not even
  the text, while History still says "sent". The gateway sends the same stanza nodes official clients
  use (`biz/interactive/native_flow` + `bot`), which is what makes them appear on Android; it cannot
  make an unsupported phone display them. **Always send one test to your own phone first.**
- **Text options** — the buttons are written as lines under the message (`👉 Reply *Yes*`,
  `🔗 Website: https://…`, `📞 Call: +91…`, footer in italics). Displayed by every client. Use this for
  anything important.

If WhatsApp rejects an interactive message, the rest of the run is sent as text options automatically.
Interactive messages do not appear in the dashboard Chat view (they bypass the normal send path) but
are tracked in Broadcast History. Retry failed keeps the mode of the original run.

## Roles

**STAFF** accounts can chat, broadcast and use the day-to-day tools on sessions shared with them, and
they see this guide in the dashboard. They cannot create/start/stop/log out/delete sessions, change bot
or privacy settings, manage webhooks, auto-replies, access grants or API keys. Those are OWNER /
SUPERADMIN actions and the API refuses them with 403.

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
