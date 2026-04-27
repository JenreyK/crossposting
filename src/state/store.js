import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_PROCESSED_POSTS = 500;

async function loadJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return {
      ...fallback,
      ...JSON.parse(raw),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function persistJson(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

export class OffsetStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.persistQueue = Promise.resolve();
    this.state = {
      offsets: {},
    };
  }

  async load() {
    this.state = await loadJson(this.filePath, {
      offsets: {},
    });
  }

  getOffset(key) {
    return Number(this.state.offsets[key]) || 0;
  }

  async saveOffset(key, offset) {
    this.state.offsets[key] = offset;
    this.persistQueue = this.persistQueue.then(() =>
      persistJson(this.filePath, this.state),
    );
    await this.persistQueue;
  }
}

export class ProcessedStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.persistQueue = Promise.resolve();
    this.state = {
      processedPosts: [],
    };
  }

  async load() {
    const loaded = await loadJson(this.filePath, {
      processedPosts: [],
    });

    this.state = {
      processedPosts: Array.isArray(loaded.processedPosts)
        ? loaded.processedPosts
        : [],
    };
  }

  hasProcessed(postKey) {
    return this.state.processedPosts.some((entry) => entry.key === postKey);
  }

  async markProcessed(postKey, details) {
    const withoutExisting = this.state.processedPosts.filter(
      (entry) => entry.key !== postKey,
    );

    withoutExisting.push({
      key: postKey,
      processedAt: new Date().toISOString(),
      details,
    });

    this.state.processedPosts = withoutExisting.slice(-MAX_PROCESSED_POSTS);
    this.persistQueue = this.persistQueue.then(() =>
      persistJson(this.filePath, this.state),
    );
    await this.persistQueue;
  }
}
