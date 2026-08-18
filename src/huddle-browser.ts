import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { JoinedHuddle } from "./huddle-types.js";

export type HuddleAudio = { data: Buffer; speakerId?: string };

export type HuddleBrowserSession = {
  speak(audio: Buffer): Promise<void>;
  close(): Promise<void>;
};

let bundle: Promise<string> | undefined;
const pageBundle = () => bundle ??= readFile(resolve("dist/huddle-page.js"), "utf8");

export class HuddleBrowser {
  private browser?: Browser;

  constructor(private chromePath: string, private silenceMs: number) {}

  async join(joined: JoinedHuddle, onAudio: (audio: HuddleAudio) => Promise<void>, onEnded: () => void): Promise<HuddleBrowserSession> {
    const browser = this.browser?.isConnected() ? this.browser : this.browser = await chromium.launch({
      executablePath: this.chromePath,
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (message) => console.log(`[huddle:${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => console.error(`[huddle:error] ${error.message}`));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    let settled = false;
    try {
      await page.exposeFunction("__kevinHuddleAudio", ({ data, speakerId }: { data: string; speakerId?: string }) => onAudio({ data: Buffer.from(data, "base64"), speakerId }));
      await page.exposeFunction("__kevinHuddleStatus", ({ type, error }: { type: string; error?: string }) => {
        if (type === "joined" && !settled) {
          settled = true;
          resolve();
        } else if (type === "error" && !settled) {
          settled = true;
          reject(new Error(error ?? "Huddle media failed"));
        } else if (type === "ended") onEnded();
      });
      await page.addInitScript((bootstrap) => Object.assign(window, { __KEVIN_HUDDLE_BOOTSTRAP__: bootstrap }), {
        meeting: joined.meeting,
        attendee: joined.attendee,
        silenceMs: this.silenceMs,
      });
      await page.route("http://localhost/huddle.js", async (route) => route.fulfill({ contentType: "text/javascript", body: await pageBundle() }));
      await page.route("http://localhost/huddle", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><script type="module" src="/huddle.js"></script></body></html>' }));
      const timer = setTimeout(() => reject(new Error("Timed out joining Chime")), 30_000);
      try {
        await page.goto("http://localhost/huddle");
        await gate;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      await context.close();
      throw error;
    }
    return new BrowserSession(context, page);
  }

  async stop() {
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close();
  }
}

class BrowserSession implements HuddleBrowserSession {
  private closed = false;

  constructor(private context: BrowserContext, private page: Page) {}

  async speak(audio: Buffer) {
    if (this.closed) throw new Error("Kevin is not in a Huddle");
    await this.page.evaluate((data) => window.kevinHuddle.speak(data), audio.toString("base64"));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.page.evaluate(() => window.kevinHuddle.leave()).catch(() => undefined);
    await this.context.close();
  }
}
