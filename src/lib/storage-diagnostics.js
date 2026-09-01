import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeFileDurable } from './durable-fs.js';

/**
 * Diagnóstico de almacenamiento SIN datos sensibles: sólo metadatos de filesystem/proceso.
 * Nunca lee ni expone contenido de folio-state.json / certification-run.json / secretos.
 */
export async function collectStorageDiagnostics(stateDir) {
  const result = {
    stateDir: String(stateDir || ''),
    processCwd: process.cwd(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    railwayVolumeMountPath: process.env.RAILWAY_VOLUME_MOUNT_PATH || '',
    realpath: null,
    realpathError: null,
    stat: null,
    statError: null,
    mountLine: null
  };

  if (!stateDir) return result;

  try {
    result.realpath = await realpath(stateDir);
  } catch (error) {
    result.realpathError = error.message;
  }

  try {
    const info = await stat(stateDir);
    result.stat = {
      mode: info.mode.toString(8),
      uid: info.uid,
      gid: info.gid,
      dev: info.dev,
      ino: info.ino,
      isDirectory: info.isDirectory()
    };
  } catch (error) {
    result.statError = error.message;
  }

  try {
    const mounts = await readFile('/proc/mounts', 'utf8');
    const target = result.realpath || stateDir;
    const lines = mounts.split('\n').filter(Boolean);
    // La línea de /proc/mounts cuyo punto de montaje sea el prefijo más largo que calce con
    // el path real de stateDir es el filesystem que realmente lo respalda.
    let best = null;
    for (const line of lines) {
      const [, mountPoint] = line.split(' ');
      if (mountPoint && target.startsWith(mountPoint) && (!best || mountPoint.length > best.split(' ')[1].length)) {
        best = line;
      }
    }
    result.mountLine = best;
  } catch (error) {
    result.mountLineError = error.message;
  }

  return result;
}

/**
 * Escribe un archivo probe NO tributario (timestamp + UUID aleatorio) en stateDir usando
 * escritura durable, lo lee de vuelta inmediatamente y confirma que el contenido coincide.
 * No usa datos fiscales/reales de ningún tipo.
 */
export async function writeStorageProbe(stateDir, filename = 'app-storage-probe.json') {
  const filePath = path.join(stateDir, filename);
  const payload = { timestamp: new Date().toISOString(), uuid: randomUUID() };
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  const writeResult = await writeFileDurable(filePath, content);
  const readBack = await readFile(filePath, 'utf8');
  return {
    filePath,
    payload,
    fileSynced: writeResult.fileSynced,
    dirSynced: writeResult.dirSynced,
    readBackMatches: readBack === content
  };
}
