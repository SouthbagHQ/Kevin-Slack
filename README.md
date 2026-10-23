# Kevin Slack self-bot

Kevin listens through Slack's browser WebSocket gateway using a user session:

- Auto mode classifies messages in channels enabled at runtime through Kevin with `google/gemini-3.5-flash-lite` and replies only when relevant.
- Ping mode replies to an `@Kevin` mention in any conversation visible to the signed-in user.
- Replies use `google/gemini-3.8-flash`, recent channel/thread context, Slack history/search/profile/user-group lookups, and persistent local memory.
- Every reply turn ends with one final action: `respond` (text, reactions on the current message, or both; optionally starting a thread, replying in the thread of another message by its `thread_ts`, or broadcasting a thread reply) or `stay_silent`. Either ends the turn immediately. A model that answers in plain text instead is treated as `respond` with that text.
- During a turn Kevin can react to any message, send messages to any conversation He belongs to, DM users, pin and unpin messages, leave channels, and set His own status. Sends are capped at three and reactions at five per turn. Leaving the current channel waits until the final action is posted.
- Messages in context carry `pinned: true` when pinned; pinned messages are read from `pins.list` (cached for a minute per channel).
- Every message Kevin writes passes through one formatter: `@channel`/`@here`/`@everyone` and user-group mentions are defused (except His channel's user group, in His channel), Markdown is rewritten as Slack mrkdwn (code untouched), a leading "Kevin:" label is dropped, and length is capped at 2,000 characters. HuddleFM protocol commands bypass it so their JSON arrives intact.
- Chat completions go to Hack Club AI first and fall back to OpenRouter if HCAI fails.
- Messages beginning with `##` are ignored. `@Kevin !stop` silences a thread until the next ping. Without auto/relevance mode, Kevin replies only to pings and DMs; a subscribed thread does not get auto replies. Channel topic, description, and name changes are treated as message events (still gated by ping/DM/auto relevance).
- Current messages and channel/thread history include a `messageType` object (`kind`, `visibility`, `fromBot`, `inThread`). Ephemeral notices delivered to Kevin are admitted and labeled `visibility: "ephemeral"` so He knows they are private to Him.
- A ping or DM can ask Kevin to enable or disable auto/relevance mode for a channel; Slack must identify the requester as one of that channel's managers.
- Kevin can remove a user from a channel when He is one of that channel's managers; Slack's channel-manager assignment for Kevin is authoritative.
- Kevin can change a channel's topic or description without being a channel manager. Slack still refuses if He is not in the channel or the workspace restricts those edits.
- Reply and relevance context include the current channel's name, topic, and description.
- Slack work is queued per thread, DM, or top-level sender. Up to four conversations run concurrently, and consecutive messages from one user are combined after a short debounce instead of producing one reply each.
- Kevin may reply to other bots. After ten consecutive Kevin↔bot replies in a thread, DM, or channel with no human message in between, He stops until a human speaks again (override with `MAX_BOT_EXCHANGES`).
- Kevin can run the music in Slack huddles through [HuddleFM](https://github.com/ingoau/huddlefm/blob/main/docs/bot-api.md). See [HuddleFM](#huddlefm).
- Kevin can join Slack huddles, listen, talk, and mute people. See [Huddles](#huddles).
- Kevin can have a channel of His own that He posts in at random and watches closely. See [Kevin's channel](#kevins-channel).
- Kevin remembers everything, and each reply is reminded only of the memories that bear on it. See [Memory](#memory).
- Image attachments are represented by opaque IDs in context. Kevin can load an image on demand through a vision tool; private Slack image URLs and bytes are not sent unless He chooses to inspect it.

## Memory

Kevin remembers everything worth remembering, but each prompt only reminds Him of what bears on the conversation at hand.

- *Recall:* a record is shown when it names a Slack user or channel in play (the sender, recent authors, huddle participants, the channel), when its meaning is close to the current message or the conversation around it, or when it shares distinctive words with them. Up to `MEMORY_PROMPT_LIMIT` records (default 25) and `MEMORY_PROMPT_CHARS` characters (default 8,000) are shown, most relevant first. Kevin is told how many records He has in all, and `search_memory` searches every one of them by meaning, words, names, or Slack IDs.
- *Embeddings:* meaning comes from `MEMORY_EMBEDDING_MODEL` (default `openai/text-embedding-3-small`, through OpenRouter with `OPENROUTER_KEY`). Each record is embedded once in the background at startup and again only when its text changes; vectors live in memory, not on disk. A record counts as close in meaning at cosine similarity `MEMORY_MIN_SIMILARITY` (default 0.35; lower shows more, higher shows less). When embeddings fail, recall falls back to IDs and keywords for a minute instead of failing the turn. `MEMORY_EMBEDDING_MODEL=off` uses IDs and keywords only.
- *Saving:* a save identical to an existing record (ignoring case and punctuation) is skipped; a save that overlaps existing records goes through and names them so Kevin can merge them with `edit_memory`. Empty records and records over 1,000 characters are refused.
- *Storage:* `MEMORY_FILE` (default `./data/memory.json`) is read once at startup and kept in memory. Every change is written atomically before it takes effect, and pending writes finish before shutdown. A file that is not valid JSON is moved aside to `memory.json.corrupt-<time>`, and Kevin starts with an empty memory instead of failing every reply.

## HuddleFM

Set `HUDDLEFM_USER_ID` to the HuddleFM Slack user's ID, and add Kevin's user ID to HuddleFM's `INTEGRATION_USER_IDS`. Without `HUDDLEFM_USER_ID`, the tools and context below are off.

- Asked to play something, skip, pause, or otherwise run the music, Kevin requests control of that huddle's session. He asks for every power except ending the session unless He decides He needs it. The host approves or declines in Slack.
- Kevin writes His own message when the host approves, declines, lets the request expire, or revokes it, and when the session ends. He writes it in the conversation where He was asked, using that channel's history and His memory. After an approval He carries out whatever He was originally asked to do.
- While Kevin controls a session, every reply in a conversation tied to it includes the live status: what is playing, the queue, volume, and recent activity. Music talk in that channel counts as relevant in auto mode.
- Kevin notices when a song He queued fails, or when someone else skips or removes it. He says so at most once every three minutes per huddle.
- Commands and replies travel as JSON DMs between Kevin and the HuddleFM user. Those DMs are never treated as conversation. Kevin keeps grants in `HUDDLEFM_FILE` (default `./data/huddlefm.json`) across restarts. When HuddleFM restarts and drops them, Kevin asks again for up to ten minutes.

## Huddles

Kevin joins huddles as Himself, using the same user session, and connects to the huddle's Amazon Chime meeting directly (no browser): Chime signaling over WebSocket and a relay-only WebRTC peer through `node-datachannel`, ported from [HuddleFM's native media backend](https://github.com/ingoau/huddlefm/tree/main/src/native-media) without the video card.

- *Invites:* invite Kevin to a huddle and He joins with the credentials the invitation carries, so He does not need to be in the channel. Set `HUDDLE_ACCEPT_INVITES=off` to stop that.
- *On request:* in chat, Kevin can check whether a huddle is running in a conversation and who is in it (`huddle_status`), join the running huddle (`join_huddle`; He only starts a new one when explicitly asked), leave (`leave_huddle`), and say something aloud from a text conversation (`speak_in_huddle`). Joining this way needs Kevin to be able to see the conversation; He joins public channels by Himself.
- *Listening:* the meeting's mixed audio is decoded, split into utterances by a voice detector, and transcribed with `openai/gpt-4o-mini-transcribe`. Chime's per-attendee volume levels say who was speaking.
- *Talking:* Kevin considers speaking when someone says His name, when He is alone with one person, right after He has spoken, and when He arrives. He may also stay silent. Replies are short, spoken in His voice by `google/gemini-3.8-flash-lite-tts` (voice `Charon`), and come from the same model, memory, and tools as His Slack replies; Slack messages in a channel where He is in the huddle see who is present and what was recently said.
- *Muting:* `mute_huddle_participant` mutes someone in a huddle Kevin is in, from chat or mid-call (the transcript gives Him speaker IDs). It sends the same `muteRequest` peer message Slack's own "Mute" menu item sends over the Chime data channel (topic `data-channel`; format from [slack-huddle-playground](https://github.com/ingoau/slack-huddle-playground)), so the person's client turns off its microphone and they can unmute themselves. Kevin cannot unmute anyone. He waits up to three seconds for Chime to report them muted and says whether it did. Huddle context and `huddle_status` show `muted: true` for muted participants.
- *Leaving:* Kevin leaves when the huddle ends, when He has been alone for about a minute, when asked, or on shutdown. He is in at most `HUDDLE_MAX_SESSIONS` huddles at once (default 2) and declines invitations beyond that.
- Transcripts stay in memory (the last 60 lines per huddle) and are never posted or saved. Logs record only their size and a short preview at `info`.

Speech goes through OpenRouter's audio endpoints with `OPENROUTER_KEY` (Hack Club AI has none). Override with `HUDDLE_STT_MODEL`, `HUDDLE_TTS_MODEL`, `HUDDLE_TTS_VOICE`, `HUDDLE_TTS_SAMPLE_RATE` (sample rate of the model's raw 16-bit mono PCM, default 24000; WAV responses carry their own), and `HUDDLE_LANGUAGE` (ISO-639-1, auto-detected when unset). `CHIME_MEDIA_REGION` (default `ap-southeast-2`) picks where Slack starts a huddle Kevin begins. `HUDDLES=off` turns all of it off.

## Managers

Set `KEVIN_MANAGERS` to a comma-separated list of Slack user IDs. A DM to Kevin from one of them that starts with `!` is a manager command, e.g. `!update the memory about Bob: he moved to Melbourne` or `!forget the shark thing`. Kevin carries it out instead of reacting to it: no refusing, stalling, fees, or bits; memory is saved, edited, rewritten, or deleted exactly as asked; and He confirms plainly what changed. Manager commands also get a `delete_memory` tool nobody else has. Fees, sign-offs, and lore are off for that turn. Tool permissions Slack enforces (channel managers, kicking, topics) are unchanged. `!` messages from anyone else, or outside a DM, are ordinary messages.

## Kevin's channel

Set `KEVIN_CHANNEL` to a channel ID to give Kevin a channel of His own. He joins it at startup if it is public; invite Him if it is private.

- *Posting:* at every minute matching `KEVIN_CHANNEL_CRON` (five-field cron; default `17 9-21 * * *`, hourly at :17 from 9am to 9pm), Kevin posts with probability `KEVIN_CHANNEL_CHANCE` (default `0.35`, about four or five posts a day), up to `KEVIN_CHANNEL_JITTER_MINUTES` (default 40) late so posts don't land on the dot. Each post draws on His memory, the channel's recent messages, the local time, and a randomly offered direction (a policy, a follow-up on someone He remembers, a fee revision, …). He may still decide to stay silent. These posts are full turns, like replies: Kevin can look things up, save memories, DM people, react, pin, join huddles, and so on before posting, `KEVIN_CHANNEL_TIMEZONE` (IANA name, e.g. `Australia/Sydney`) sets the zone for the schedule and the time He is told; the process's zone is used when unset.
- *Messages:* every message in the channel goes straight to Kevin's reply model, with no relevance classifier and no ping needed. He replies, reacts, or stays silent.
- *Oversight:* joins, departures (including removals, which Slack reports as membership events without a "has left" message; a join or departure reported both ways counts once), pins, huddles starting, people joining or leaving the channel's huddle, and reactions added or removed all wake Kevin. Events are batched: He looks once things have been quiet for 15 seconds (at most a minute after the first), sees up to the 20 newest, and gets the same tools as a reply. He posts, reacts, or stays silent. His own actions don't count.
- *User group:* with `KEVIN_CHANNEL_USER_GROUP` set to a user group ID (`S…`), everyone who joins the channel is added to that group, keeping its existing members, before Kevin looks at the join. He is told whether that worked. The signed-in user needs permission to edit the group. Kevin is also told about the group (by handle, looked up at startup) and uses it like a channel ping: His own posts in His channel can open with `<!subteam^…>` to notify every member when He has an update or a thought He wants them all to see, but not in replies to individual people or remarks on routine events. That group's mention goes through as a real ping only in His channel; everywhere else, and for every other group, group mentions are still defused.

## Logs

Every component logs through `src/logger.ts`: one line per event with a timestamp, a level, the scope that emitted it, and `key=value` fields.

```
2026-09-17T11:31:34.087Z INFO  [reply] Replied channel=C123 ts=1758108694.001 trigger=ping replyTs=1758108701.002 chars=182 ms=4310
2026-09-17T11:31:34.089Z WARN  [chat] Chat request rejected provider="Hack Club AI" attempt=1 status=429 retryable=true ms=812
```

- `LOG_LEVEL` selects verbosity: `error`, `warn`, `info` (default), `debug`, `trace`. `info` covers startup, accepted messages, relevance decisions, tool calls, model completions, posted replies, and every denied privileged action; `debug` adds dropped-message reasons, per-call Slack API timings, queue depth, and context sizes; `trace` adds raw gateway event and typing-indicator activity.
- `LOG_FORMAT=json` emits one JSON object per line for log shippers; `text` (default) is the human-readable form above.
- Slack tokens, cookies, and API keys are redacted by field name and by value shape, long values are truncated (`LOG_MAX_FIELD`, default 500 characters), and message text is logged only as a short preview. Prompts, tool payloads, and image bytes are never logged — only their size and shape.
- Failures log the error type, code, cause, and stack.

## Reliability

- Slack Web API calls time out after 20 seconds and retry at most three times, so a failing call ends a turn quickly instead of stalling a queue slot.
- The gateway reconnects with exponential backoff (2 seconds up to a minute, with jitter), fetches a fresh gateway URL after three failed reconnects in a row, and drops a socket that has been silent for 100 seconds (Slack answers every 30-second ping).
- A chat provider that times out is not retried; the fallback answers. After two failed requests in a row, Hack Club AI is skipped for a minute and OpenRouter answers directly. Short `Retry-After` hints are honored.
- Channel info is cached for a minute and user info for five minutes (Kevin's own topic, description, membership, and kick changes clear the channel's entry); failed lookups are never cached. Consecutive read-only tool calls in a round run concurrently.

## Run

Requires Node.js 20+.

```sh
cp .env.example .env
npm install
npm start
```

## Docker

The image runs as a non-root user and stores channel modes, memory, and thread state in `/app/data`.

```sh
docker build -t kevin-slack .
docker run -d --name kevin-slack --restart unless-stopped --shm-size=256m \
  --env-file .env -v "$(pwd)/data:/app/data" kevin-slack
```

Pushes to `master`, the weekly schedule, and manual workflow runs publish `ghcr.io/southbaghq/kevin-slack:latest` plus a commit-SHA tag.

Set `HACKCLUB_AI_KEY`, `OPENROUTER_KEY`, `SLACK_XOXC`, and `SLACK_XOXD` in `.env`. Get a Hack Club AI key from [docs.ai.hackclub.com](https://docs.ai.hackclub.com/). OpenRouter is used only when Hack Club AI fails. The Slack values are full `xoxc-…` and `xoxd-…` values; do not add `d=` around the cookie.

To import credentials from an `agent-browser state save` file without printing them:

```sh
npm run import-slack-state -- /path/to/state.json .env --delete
```

Session credentials provide the same access as the user account. Keep `.env` private. Slack does not officially support browser-session self-bots or its private gateway protocol, and either can change or expire without warning.
