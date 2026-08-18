# Kevin Slack self-bot

Kevin listens through Slack's browser WebSocket gateway using a user session:

- Auto mode classifies every new message in `C0BQG11SC8P` with `google/gemini-3.5-flash-lite` and replies only when relevant.
- Ping mode replies to an `@Kevin` mention in any conversation visible to the signed-in user.
- Replies use `google/gemini-3.5-flash`, recent channel/thread context, read-only Slack history/search tools, and persistent local memory.

## Run

Requires Node.js 20+.

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
