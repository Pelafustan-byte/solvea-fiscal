import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectStorageDiagnostics, writeStorageProbe } from '../src/lib/storage-diagnostics.js';

test('collectStorageDiagnostics: no expone datos fiscales, sólo metadatos de filesystem', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-fiscal-storage-diag-'));
  try {
    const result = await collectStorageDiagnostics(dir);
    assert.equal(result.stateDir, dir);
    assert.equal(typeof result.processCwd, 'string');
    assert.ok(result.stat);
    assert.equal(result.stat.isDirectory, true);
    assert.equal(typeof result.stat.mode, 'string');
    const serialized = JSON.stringify(result);
    for (const forbidden of ['SII_CERT', 'RSASK', 'PFX', 'CAF_39']) {
      assert.ok(!serialized.includes(forbidden), `no debe mencionar ${forbidden}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('collectStorageDiagnostics: sin stateDir devuelve estructura vacía sin lanzar', async () => {
  const result = await collectStorageDiagnostics('');
  assert.equal(result.realpath, null);
  assert.equal(result.stat, null);
});

test('writeStorageProbe: escribe, lee de vuelta y confirma coincidencia — nunca datos fiscales', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-fiscal-storage-probe-'));
  try {
    const result = await writeStorageProbe(dir);
    assert.equal(result.fileSynced, true);
    assert.equal(result.readBackMatches, true);
    assert.ok(result.payload.uuid);
    assert.ok(result.payload.timestamp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
