import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileCertificationArmStore, MemoryCertificationArmStore } from '../src/services/certification-arm-store.js';

async function withStore(handler) {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-fiscal-arm-'));
  try {
    await handler(new FileCertificationArmStore({ stateDir: dir }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('arm + consume: un arm válido se consume exactamente una vez', async () => {
  await withStore(async (store) => {
    await store.arm({ cafId: 'caf-1', from: 46, to: 50 });
    const first = await store.consume({ cafId: 'caf-1', from: 46, to: 50 });
    assert.equal(first.ok, true);
    assert.equal(first.arm.cafId, 'caf-1');

    const second = await store.consume({ cafId: 'caf-1', from: 46, to: 50 });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'not_armed');
  });
});

test('consume: falla si no hay ningún arm creado', async () => {
  await withStore(async (store) => {
    const result = await store.consume({ cafId: 'caf-1', from: 46, to: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_armed');
  });
});

test('consume: falla si el CAF no coincide (sigue consumiendo el arm igual, es de un solo uso)', async () => {
  await withStore(async (store) => {
    await store.arm({ cafId: 'caf-1', from: 46, to: 50 });
    const wrongCaf = await store.consume({ cafId: 'caf-otro', from: 46, to: 50 });
    assert.equal(wrongCaf.ok, false);
    assert.equal(wrongCaf.reason, 'caf_mismatch');
    const retry = await store.consume({ cafId: 'caf-1', from: 46, to: 50 });
    assert.equal(retry.ok, false, 'el arm ya se consumió, incluso tras un mismatch');
  });
});

test('consume: falla si el rango no coincide', async () => {
  await withStore(async (store) => {
    await store.arm({ cafId: 'caf-1', from: 46, to: 50 });
    const result = await store.consume({ cafId: 'caf-1', from: 1, to: 5 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'range_mismatch');
  });
});

test('consume: falla si el arm expiró (TTL)', async () => {
  await withStore(async (store) => {
    await store.arm({ cafId: 'caf-1', from: 46, to: 50, ttlMs: -1000 });
    const result = await store.consume({ cafId: 'caf-1', from: 46, to: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
  });
});

test('arm nuevo reemplaza uno anterior no consumido', async () => {
  await withStore(async (store) => {
    await store.arm({ cafId: 'caf-1', from: 46, to: 50 });
    await store.arm({ cafId: 'caf-1', from: 51, to: 55 });
    const result = await store.consume({ cafId: 'caf-1', from: 46, to: 50 });
    assert.equal(result.ok, false, 'el arm viejo ya no debe ser válido');
    assert.equal(result.reason, 'range_mismatch');
  });
});

test('concurrencia: dos consume() simultáneos sobre el mismo arm — sólo uno gana', async () => {
  await withStore(async (store) => {
    await store.arm({ cafId: 'caf-1', from: 46, to: 50 });
    const [a, b] = await Promise.all([
      store.consume({ cafId: 'caf-1', from: 46, to: 50 }),
      store.consume({ cafId: 'caf-1', from: 46, to: 50 })
    ]);
    const oks = [a, b].filter((r) => r.ok);
    assert.equal(oks.length, 1, 'exactamente uno de los dos debe ganar el arm');
  });
});

test('MemoryCertificationArmStore: mismo contrato que la versión de archivo', async () => {
  const store = new MemoryCertificationArmStore();
  await store.arm({ cafId: 'caf-mem', from: 1, to: 5 });
  const result = await store.consume({ cafId: 'caf-mem', from: 1, to: 5 });
  assert.equal(result.ok, true);
  const again = await store.consume({ cafId: 'caf-mem', from: 1, to: 5 });
  assert.equal(again.ok, false);
});

test('startup: sin ningún arm() previo, consume() siempre falla (cerrado por defecto)', async () => {
  await withStore(async (store) => {
    const result = await store.consume({ cafId: 'cualquiera', from: 1, to: 5 });
    assert.equal(result.ok, false);
  });
});
