import { mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * Escribe un archivo de forma durable: temp -> fsync(archivo) -> close -> rename ->
 * fsync(directorio padre) best-effort. No retorna hasta que la escritura del archivo esté
 * confirmada por el filesystem (fdatasync/fsync vía FileHandle#sync()). El fsync del
 * directorio padre es best-effort: algunos filesystems/plataformas no lo soportan (p.ej.
 * ciertos filesystems de red o Windows en algunos casos) — si falla, se documenta en el
 * resultado devuelto pero NO se considera un error fatal, porque el archivo en sí ya quedó
 * sincronizado.
 */
export async function writeFileDurable(filePath, content, { mode = 0o600 } = {}) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmp, 'w', mode);
  let fileSynced = false;
  try {
    await handle.writeFile(content);
    await handle.sync();
    fileSynced = true;
  } finally {
    await handle.close();
  }

  await rename(tmp, filePath);

  let dirSynced = false;
  try {
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
      dirSynced = true;
    } finally {
      await dirHandle.close();
    }
  } catch {
    dirSynced = false; // best-effort: no soportado en esta plataforma/filesystem, no es fatal.
  }

  return { filePath, fileSynced, dirSynced };
}
