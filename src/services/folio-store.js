import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MemoryFolioStore {
  #state = { nextByCaf: {}, reservations: {} };

  async peek({ caf }) {
    const next = Number(this.#state.nextByCaf[caf.id] ?? caf.from);
    const used = Math.max(0, next - caf.from);
    const total = caf.to - caf.from + 1;
    return { next, used, total, available: Math.max(0, total - used) };
  }

  async reserve({ caf, idempotencyKey, payloadHash, timestamp }) {
    const existing = this.#state.reservations[idempotencyKey];
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw httpError(409, 'La idempotencyKey ya fue utilizada con otro contenido.');
      if (existing.cafId !== caf.id) throw httpError(409, 'La reserva existente corresponde a un CAF distinto.');
      return existing;
    }

    const next = Number(this.#state.nextByCaf[caf.id] ?? caf.from);
    if (!Number.isInteger(next) || next > caf.to) throw httpError(409, `CAF agotado para TipoDTE ${caf.documentType}.`);
    const reservation = { cafId: caf.id, folio: next, timestamp, payloadHash };
    this.#state.nextByCaf[caf.id] = next + 1;
    this.#state.reservations[idempotencyKey] = reservation;
    return reservation;
  }

  async getBatch({ runId }) {
    return this.#state.batches?.[runId] || null;
  }

  async reserveBatch({ caf, count, runId, timestamp = new Date().toISOString() }) {
    if (!runId) throw httpError(422, 'runId es obligatorio para reservar un lote de folios.');
    if (!Number.isInteger(count) || count <= 0) throw httpError(422, 'count debe ser un entero positivo.');
    this.#state.batches = this.#state.batches || {};
    const existing = this.#state.batches[runId];
    if (existing) {
      if (existing.cafId !== caf.id) throw httpError(409, 'La corrida ya existe para un CAF distinto.');
      if (existing.count !== count) throw httpError(409, 'La corrida ya existe con una cantidad de folios distinta.');
      return existing;
    }

    const next = Number(this.#state.nextByCaf[caf.id] ?? caf.from);
    if (!Number.isInteger(next)) throw httpError(500, 'Estado de folios corrupto.');
    const last = next + count - 1;
    if (last > caf.to) {
      throw httpError(409, `CAF no tiene ${count} folios contiguos disponibles (próximo folio ${next}, tope ${caf.to}).`);
    }
    const folios = Array.from({ length: count }, (_, i) => next + i);
    const batch = { runId, cafId: caf.id, count, folios, from: folios[0], to: folios.at(-1), timestamp };
    this.#state.nextByCaf[caf.id] = last + 1;
    this.#state.batches[runId] = batch;
    return batch;
  }
}

export class FileFolioStore {
  constructor({ stateDir }) {
    if (!stateDir) throw new Error('stateDir es obligatorio para FileFolioStore.');
    this.stateDir = path.resolve(stateDir);
    this.stateFile = path.join(this.stateDir, 'folio-state.json');
    this.lockFile = path.join(this.stateDir, 'folio-state.lock');
  }

  async #readState() {
    try {
      const raw = await readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        nextByCaf: parsed?.nextByCaf && typeof parsed.nextByCaf === 'object' ? parsed.nextByCaf : {},
        reservations: parsed?.reservations && typeof parsed.reservations === 'object' ? parsed.reservations : {},
        batches: parsed?.batches && typeof parsed.batches === 'object' ? parsed.batches : {}
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { nextByCaf: {}, reservations: {}, batches: {} };
      throw error;
    }
  }

  async #writeState(state) {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.stateFile);
  }

  async #removeStaleLock() {
    try {
      const info = await stat(this.lockFile);
      if (Date.now() - info.mtimeMs > 30_000) await unlink(this.lockFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async #withLock(handler) {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 5_000;
    let handle;
    while (!handle) {
      try {
        handle = await open(this.lockFile, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await this.#removeStaleLock();
        if (Date.now() >= deadline) throw httpError(503, 'No fue posible adquirir el bloqueo de reserva de folios.');
        await sleep(25 + Math.floor(Math.random() * 50));
      }
    }

    try {
      return await handler();
    } finally {
      await handle.close().catch(() => {});
      await unlink(this.lockFile).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async peek({ caf }) {
    const state = await this.#readState();
    const next = Number(state.nextByCaf[caf.id] ?? caf.from);
    const used = Math.max(0, next - caf.from);
    const total = caf.to - caf.from + 1;
    return { next, used, total, available: Math.max(0, total - used) };
  }

  async reserve({ caf, idempotencyKey, payloadHash, timestamp }) {
    return this.#withLock(async () => {
      const state = await this.#readState();
      const existing = state.reservations[idempotencyKey];
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw httpError(409, 'La idempotencyKey ya fue utilizada con otro contenido.');
        if (existing.cafId !== caf.id) throw httpError(409, 'La reserva existente corresponde a un CAF distinto.');
        return existing;
      }

      const next = Number(state.nextByCaf[caf.id] ?? caf.from);
      if (!Number.isInteger(next) || next > caf.to) throw httpError(409, `CAF agotado para TipoDTE ${caf.documentType}.`);
      const reservation = { cafId: caf.id, folio: next, timestamp, payloadHash };
      state.nextByCaf[caf.id] = next + 1;
      state.reservations[idempotencyKey] = reservation;
      await this.#writeState(state);
      return reservation;
    });
  }

  async getBatch({ runId }) {
    const state = await this.#readState();
    return state.batches[runId] || null;
  }

  async reserveBatch({ caf, count, runId, timestamp = new Date().toISOString() }) {
    if (!runId) throw httpError(422, 'runId es obligatorio para reservar un lote de folios.');
    if (!Number.isInteger(count) || count <= 0) throw httpError(422, 'count debe ser un entero positivo.');
    return this.#withLock(async () => {
      const state = await this.#readState();
      const existing = state.batches[runId];
      if (existing) {
        if (existing.cafId !== caf.id) throw httpError(409, 'La corrida ya existe para un CAF distinto.');
        if (existing.count !== count) throw httpError(409, 'La corrida ya existe con una cantidad de folios distinta.');
        return existing;
      }

      const next = Number(state.nextByCaf[caf.id] ?? caf.from);
      if (!Number.isInteger(next)) throw httpError(500, 'Estado de folios corrupto.');
      const last = next + count - 1;
      if (last > caf.to) {
        throw httpError(409, `CAF no tiene ${count} folios contiguos disponibles (próximo folio ${next}, tope ${caf.to}).`);
      }
      const folios = Array.from({ length: count }, (_, i) => next + i);
      const batch = { runId, cafId: caf.id, count, folios, from: folios[0], to: folios.at(-1), timestamp };
      state.nextByCaf[caf.id] = last + 1;
      state.batches[runId] = batch;
      await this.#writeState(state);
      return batch;
    });
  }
}

export function createFolioStore(config) {
  return config.stateDir ? new FileFolioStore({ stateDir: config.stateDir }) : new MemoryFolioStore();
}
