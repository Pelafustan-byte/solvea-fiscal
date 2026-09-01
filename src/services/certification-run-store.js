import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileDurable } from '../lib/durable-fs.js';

export class MemoryCertificationRunStore {
  #runs = new Map();
  async get(runId) { return this.#runs.get(runId) || null; }
  async put(runId, value) { this.#runs.set(runId, structuredClone(value)); return value; }
  async list() { return [...this.#runs.values()]; }
}

export class FileCertificationRunStore {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('stateDir es obligatorio.');
    this.dir = path.resolve(stateDir);
    this.file = path.join(this.dir, 'certification-run.json');
    this.queue = Promise.resolve();
  }

  async #read() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async #write(state) {
    await writeFileDurable(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }

  async #serialized(handler) {
    const current = this.queue.then(handler, handler);
    this.queue = current.catch(() => {});
    return current;
  }

  async get(runId) {
    return this.#serialized(async () => (await this.#read())[runId] || null);
  }

  async put(runId, value) {
    if (!runId) throw new Error('runId vacío.');
    return this.#serialized(async () => {
      const state = await this.#read();
      state[runId] = structuredClone(value);
      await this.#write(state);
      return value;
    });
  }

  async list() {
    return this.#serialized(async () => Object.values(await this.#read()));
  }
}

export function createCertificationRunStore(config) {
  return config.stateDir ? new FileCertificationRunStore({ stateDir: config.stateDir }) : new MemoryCertificationRunStore();
}
