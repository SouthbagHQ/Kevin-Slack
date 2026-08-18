import { chmod, readFile, unlink, writeFile } from "node:fs/promises";

const [stateFile, envFile = ".env", remove] = process.argv.slice(2);
if (!stateFile) throw new Error("Usage: npm run import-slack-state -- <state.json> [.env] [--delete]");

const stateText = await readFile(stateFile, "utf8");
const state = JSON.parse(stateText);
const token = stateText.match(/xoxc-[A-Za-z0-9-]+/)?.[0];
const cookie = state.cookies?.find(({ name, domain }) => name === "d" && domain.endsWith("slack.com"))?.value;
const cookieS = state.cookies?.find(({ name, domain }) => name === "d-s" && domain.endsWith("slack.com"))?.value;
if (!token || !cookie?.startsWith("xoxd-")) throw new Error("Slack xoxc token or d cookie not found");

let env = await readFile(envFile, "utf8").catch(() => "");
for (const [key, value] of Object.entries({ SLACK_XOXC: token, SLACK_XOXD: cookie, ...(cookieS ? { SLACK_XOXD_S: cookieS } : {}) })) {
  const line = `${key}=${value}`;
  env = new RegExp(`^${key}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${env.trimEnd()}\n${line}\n`;
}
await writeFile(envFile, env, { mode: 0o600 });
await chmod(envFile, 0o600);
if (remove === "--delete") await unlink(stateFile);
console.log("Imported Slack session credentials without displaying them.");
