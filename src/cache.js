import fs from "node:fs/promises";
import path from "node:path";

export class DiskCache {
  constructor({ enabled, dir }) {
    this.enabled = Boolean(enabled);
    this.dir = dir;
  }

  async get(key) {
    if (!this.enabled) return null;
    try {
      const raw = await fs.readFile(this.#filePath(key), "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async set(key, value) {
    if (!this.enabled) return;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.#filePath(key), JSON.stringify({
      ...value,
      cached_at: new Date().toISOString()
    }, null, 2));
  }

  #filePath(key) {
    return path.join(this.dir, `${key}.json`);
  }
}
