import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BRANDING = {
  logo: '',
  businessName: '',
  footerMessage: '',
  showRegister: true,
  showSeller: false,
  showQr: false
};

function normalizeBranding(partial) {
  const merged = { ...DEFAULT_BRANDING, ...partial };
  return {
    logo: String(merged.logo || ''),
    businessName: String(merged.businessName || '').slice(0, 80),
    footerMessage: String(merged.footerMessage || '').slice(0, 160),
    showRegister: Boolean(merged.showRegister),
    showSeller: Boolean(merged.showSeller),
    showQr: Boolean(merged.showQr)
  };
}

export class MemoryBrandingStore {
  #branding = { ...DEFAULT_BRANDING };
  async get() { return { ...this.#branding }; }
  async update(partial) { this.#branding = normalizeBranding({ ...this.#branding, ...partial }); return { ...this.#branding }; }
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

  async get() {
    return normalizeBranding(await this.#read());
  }

  async update(partial) {
    const next = normalizeBranding({ ...(await this.#read()), ...partial });
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.file);
    return next;
  }
}

export function createBrandingStore(config) {
  return config.stateDir ? new FileBrandingStore({ stateDir: config.stateDir }) : new MemoryBrandingStore();
}
