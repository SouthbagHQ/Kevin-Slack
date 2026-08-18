import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class ChannelModes {
  private enabled: Set<string>;
  private writes = Promise.resolve();

  constructor(private file: string, defaults: string[] = []) {
    this.enabled = new Set(defaults);
  }

  async load() {
    try {
      this.enabled = new Set(JSON.parse(await readFile(this.file, "utf8")) as string[]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this;
  }

  isEnabled(channel: string) {
    return this.enabled.has(channel);
  }

  list() {
    return [...this.enabled];
  }

  async set(channel: string, enabled: boolean) {
    enabled ? this.enabled.add(channel) : this.enabled.delete(channel);
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(this.list(), null, 2), { mode: 0o600 });
      await rename(temp, this.file);
    });
    this.writes = write.then(() => undefined, () => undefined);
    await write;
  }
}
