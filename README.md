# Kevin Slack self-bot

Kevin listens through Slack's browser WebSocket gateway using a user session:

- Auto mode classifies messages in channels enabled at runtime through Kevin with `google/gemini-3.8-flash` and replies only when relevant.
- Ping mode replies to an `@Kevin` mention in any conversation visible to the signed-in user.
- Replies use `google/gemini-3.8-flash`, recent channel/thread context, read-only Slack history/search tools, and persistent local memory.
- Chat completions go to Hack Club AI first and fall back to OpenRouter if HCAI fails.
- Messages beginning with `##` are ignored. `@Kevin !stop` silences a thread until the next ping. Without auto/relevance mode, Kevin replies only to pings and DMs; a subscribed thread does not get auto replies. Channel topic, description, and name changes are treated as message events (still gated by ping/DM/auto relevance).
- Current messages and channel/thread history include a `messageType` object (`kind`, `visibility`, `fromBot`, `inThread`). Ephemeral notices delivered to Kevin are admitted and labeled `visibility: "ephemeral"` so He knows they are private to Him.
- A ping or DM can ask Kevin to enable or disable auto/relevance mode for a channel; Slack must identify the requester as one of that channel's managers.
- Kevin can remove a user from a channel, or change that channel's topic or description, when He is one of that channel's managers; Slack's channel-manager assignment for Kevin is authoritative.
- Reply and relevance context include the current channel's name, topic, and description.
- Slack work is queued per thread, DM, or top-level sender. Up to four conversations run concurrently, and consecutive messages from one user are combined after a short debounce instead of producing one reply each.
- Kevin may reply to other bots. After ten consecutive Kevin↔bot replies in a thread, DM, or channel with no human message in between, He stops until a human speaks again (override with `MAX_BOT_EXCHANGES`).
- Image attachments are represented by opaque IDs in context. Kevin can load an image on demand through a vision tool; private Slack image URLs and bytes are not sent unless He chooses to inspect it.

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
