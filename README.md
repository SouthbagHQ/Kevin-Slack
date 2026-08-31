# Kevin Slack self-bot

Kevin listens through Slack's browser WebSocket gateway using a user session:

- Auto mode classifies messages in channels enabled at runtime through Kevin with `google/gemini-3.5-flash-lite` and replies only when relevant.
- Ping mode replies to an `@Kevin` mention in any conversation visible to the signed-in user.
- Replies use `google/gemini-3.5-flash-lite`, recent channel/thread context, read-only Slack history/search tools, and persistent local memory.
- Messages beginning with `##` are ignored. `@Kevin !stop` silences a thread until the next ping. Without auto/relevance mode, Kevin replies only to pings and DMs; a subscribed thread does not get auto replies.
- A ping or DM can ask Kevin to enable or disable auto/relevance mode for a channel; Slack must identify the requester as one of that channel's managers.
- Slack work is queued per thread, DM, or top-level sender. Up to four conversations run concurrently, and consecutive messages from one user are combined after a short debounce instead of producing one reply each.
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

Set `OPENROUTER_KEY`, `SLACK_XOXC`, and `SLACK_XOXD` in `.env`. The Slack values are full `xoxc-…` and `xoxd-…` values; do not add `d=` around the cookie.

To import credentials from an `agent-browser state save` file without printing them:

```sh
npm run import-slack-state -- /path/to/state.json .env --delete
```

Session credentials provide the same access as the user account. Keep `.env` private. Slack does not officially support browser-session self-bots or its private gateway protocol, and either can change or expire without warning.
