import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileDurable } from '../lib/durable-fs.js';
import { withFileLock } from '../lib/file-lock.js';

const DEFAULT_TTL_MS = 5 * 60_000;

function buildArm({ cafId, from, to, ttlMs }) {
  const now = Date.now();
  return {
    armed: true,
    cafId,
    expectedRange: { from, to },
    nonce: randomUUID(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString()
  };
}

function evaluateConsume(current, { cafId, from, to }) {
  if (!current || !current.armed) return { ok: false, reason: 'not_armed' };
  if (new Date(current.expiresAt).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (current.cafId !== cafId) return { ok: false, reason: 'caf_mismatch' };
  if (current.expectedRange?.from !== from || current.expectedRange?.to !== to) return { ok: false, reason: 'range_mismatch' };
  return { ok: true, arm: current };
}

/**
 * Segundo nivel de seguridad ("runtime one-shot arm"), independiente del master gate
 * (SII_CERTIFICATION_SUBMISSION_ENABLED). Un arm se genera explícitamente, vence a los pocos
 * minutos y se consume ATÓMICAMENTE (lectura+borrado en la misma operación) la primera vez que
 * se usa — así un segundo submit() nunca reutiliza el mismo arm, sin depender de un redeploy
 * para "cerrar" nada.
 */
export class MemoryCertificationArmStore {
  #arm = null;

  async get() { return this.#arm; }

  async arm({ cafId, from, to, ttlMs = DEFAULT_TTL_MS }) {
    this.#arm = buildArm({ cafId, from, to, ttlMs });
    return this.#arm;
  }

  async consume({ cafId, from, to }) {
    const current = this.#arm;
    this.#arm = null; // siempre se limpia, sea cual sea el resultado: es de un solo uso.
    return evaluateConsume(current, { cafId, from, to });
  }
}

export class FileCertificationArmStore {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('stateDir es obligatorio.');
    this.dir = path.resolve(stateDir);
    this.file = path.join(this.dir, 'certification-arm.json');
    this.lockFile = path.join(this.dir, 'certification-arm.lock');
  }

  async #readState() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && parsed.armed ? parsed : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #writeState(state) {
    await writeFileDurable(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }

  async #withLock(handler) {
    return withFileLock({ dir: this.dir, lockFile: this.lockFile }, handler);
  }

  async get() {
    return this.#withLock(() => this.#readState());
  }

  async arm({ cafId, from, to, ttlMs = DEFAULT_TTL_MS }) {
    return this.#withLock(async () => {
      const record = buildArm({ cafId, from, to, ttlMs });
      await this.#writeState(record);
      return record;
    });
  }

  async consume({ cafId, from, to }) {
    return this.#withLock(async () => {
      const current = await this.#readState();
      await this.#writeState(null); // borrado durable dentro del mismo lock: atómico y de un solo uso.
      return evaluateConsume(current, { cafId, from, to });
    });
  }
}

export function createCertificationArmStore(config) {
  return config.stateDir ? new FileCertificationArmStore({ stateDir: config.stateDir }) : new MemoryCertificationArmStore();
}
