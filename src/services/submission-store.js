import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export class MemorySubmissionStore {
  #records = new Map();
  async get(key) { return this.#records.get(key) || null; }
  async put(key, value) { this.#records.set(key, structuredClone(value)); return value; }
}

export class FileSubmissionStore {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('stateDir es obligatorio.');
    this.dir = path.resolve(stateDir);
    this.file = path.join(this.dir, 'submission-state.json');
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
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.file);
  }

  async #serialized(handler) {
    const current = this.queue.then(handler, handler);
    this.queue = current.catch(() => {});
    return current;
  }

  async get(key) {
    return this.#serialized(async () => (await this.#read())[key] || null);
  }

  async put(key, value) {
    if (!key) throw httpError(422, 'Clave de envío vacía.');
    return this.#serialized(async () => {
      const state = await this.#read();
      state[key] = structuredClone(value);
      await this.#write(state);
      return value;
    });
  }
}

export function createSubmissionStore(config) {
  return config.stateDir ? new FileSubmissionStore({ stateDir: config.stateDir }) : new MemorySubmissionStore();
}
