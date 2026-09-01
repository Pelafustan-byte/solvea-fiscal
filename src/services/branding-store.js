import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class MemoryBrandingStore {
  #logo = null;
  async getLogo() { return this.#logo; }
  async setLogo(dataUri) { this.#logo = dataUri; return dataUri; }
}

export class FileBrandingStore {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('stateDir es obligatorio.');
    this.dir = path.resolve(stateDir);
    this.file = path.join(this.dir, 'branding.json');
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

  async getLogo() {
    const state = await this.#read();
    return state.logo || null;
  }

  async setLogo(dataUri) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ logo: dataUri }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.file);
    return dataUri;
  }
}

export function createBrandingStore(config) {
  return config.stateDir ? new FileBrandingStore({ stateDir: config.stateDir }) : new MemoryBrandingStore();
}
