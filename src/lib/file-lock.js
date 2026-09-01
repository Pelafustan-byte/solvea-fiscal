import { mkdir, open, stat, unlink } from 'node:fs/promises';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lock exclusivo basado en creación atómica de archivo (open con flag 'wx'). Limpia locks
 * huérfanos de más de 30s. Usado por los stores persistentes (folios, run, arm) para que
 * lecturas+escrituras compuestas (leer-modificar-escribir) sean atómicas entre procesos.
 */
export async function withFileLock({ dir, lockFile, timeoutMs = 5_000 }, handler) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockFile);
        if (Date.now() - info.mtimeMs > 30_000) await unlink(lockFile);
      } catch (staleError) {
        if (staleError.code !== 'ENOENT') throw staleError;
      }
      if (Date.now() >= deadline) {
        const error = new Error(`No fue posible adquirir el bloqueo (${lockFile}).`);
        error.status = 503;
        throw error;
      }
      await sleep(25 + Math.floor(Math.random() * 50));
    }
  }

  try {
    return await handler();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockFile).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
