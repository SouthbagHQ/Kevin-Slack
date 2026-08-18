# Kevin Slack self-bot

Kevin listens through Slack's browser WebSocket gateway using a user session:

- Auto mode classifies every new message in `C0BQG11SC8P` with `google/gemini-3.5-flash-lite` and replies only when relevant.
- Ping mode replies to an `@Kevin` mention in any conversation visible to the signed-in user.
- Replies use `google/gemini-3.5-flash`, recent channel/thread context, read-only Slack history/search tools, and persistent local memory.
- Messages beginning with `##` are ignored. A ping subscribes Kevin to that thread for relevant replies; `@Kevin !stop` silences it until the next ping.
- A ping or DM can ask Kevin to enable or disable auto/relevance mode for a channel; Slack must identify the requester as one of that channel's managers.
- Kevin automatically accepts Huddle invitations while free, can join an active Huddle when asked, and exposes a leave tool while inside one. Competing invitations are declined.
- Huddle audio is transcribed with `qwen/qwen3-asr-0.6b`; replies are spoken with `hexgrad/kokoro-82m`. The Chromium session sends and receives audio only—no camera or video feed.
- Slack work is queued per thread, DM, or top-level sender. Up to four conversations run concurrently, and consecutive messages from one user are combined after a short debounce instead of producing one reply each.
- Image attachments are represented by opaque IDs in context. Kevin can load an image on demand through a vision tool; private Slack image URLs and bytes are not sent unless He chooses to inspect it.

## Run

Requires Node.js 20+, Bun, and Chromium.

```sh
cp .env.example .env
npm install
npm start
```

Set `OPENROUTER_KEY`, `SLACK_XOXC`, and `SLACK_XOXD` in `.env`. The Slack values are full `xoxc-…` and `xoxd-…` values; do not add `d=` around the cookie.

To import credentials from an `agent-browser state save` file without printing them:

```sh
npm run import-slack-state -- /path/to/state.json .env --delete
```

Session credentials provide the same access as the user account. Keep `.env` private. Slack does not officially support browser-session self-bots or its private gateway protocol, and either can change or expire without warning.
