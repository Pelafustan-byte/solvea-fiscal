import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileDurable } from '../src/lib/durable-fs.js';

test('writeFileDurable: escribe el contenido exacto y confirma fsync del archivo', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-fiscal-durable-'));
  try {
    const file = path.join(dir, 'sub', 'estado.json');
    const result = await writeFileDurable(file, '{"a":1}\n');
    assert.equal(result.fileSynced, true);
    assert.equal(typeof result.dirSynced, 'boolean');
    const content = await readFile(file, 'utf8');
    assert.equal(content, '{"a":1}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeFileDurable: sobrescribe atómicamente (rename), nunca deja el archivo a medio escribir', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-fiscal-durable-'));
  try {
    const file = path.join(dir, 'estado.json');
    await writeFileDurable(file, 'primero');
    await writeFileDurable(file, 'segundo-mas-largo-que-el-anterior');
    const content = await readFile(file, 'utf8');
    assert.equal(content, 'segundo-mas-largo-que-el-anterior');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeFileDurable: no deja archivos .tmp huérfanos tras una escritura exitosa', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-fiscal-durable-'));
  try {
    const file = path.join(dir, 'estado.json');
    await writeFileDurable(file, 'contenido');
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['estado.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
