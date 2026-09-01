import test from 'node:test';
import assert from 'node:assert/strict';
import { SiiBoletaLookupClient, classifyEstadoBoletaCodigo } from '../src/sii/boleta-lookup-client.js';

function jsonResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

test('classifyEstadoBoletaCodigo: DOK/DNK/FAN y notas de crédito/débito son FOUND', () => {
  for (const code of ['DOK', 'DNK', 'FAN', 'TMD', 'TMC', 'MMD', 'MMC', 'AND', 'ANC']) {
    assert.equal(classifyEstadoBoletaCodigo(code), 'FOUND', code);
  }
});

test('classifyEstadoBoletaCodigo: FAU y FNA son NOT_FOUND explícito', () => {
  assert.equal(classifyEstadoBoletaCodigo('FAU'), 'NOT_FOUND');
  assert.equal(classifyEstadoBoletaCodigo('FNA'), 'NOT_FOUND');
});

test('classifyEstadoBoletaCodigo: EMP y códigos desconocidos son UNKNOWN, nunca NOT_FOUND', () => {
  assert.equal(classifyEstadoBoletaCodigo('EMP'), 'UNKNOWN');
  assert.equal(classifyEstadoBoletaCodigo(''), 'UNKNOWN');
  assert.equal(classifyEstadoBoletaCodigo('ALGO-RARO'), 'UNKNOWN');
});

test('checkDocument: codigo=DOK se traduce a FOUND con la ruta exacta del spec oficial', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};
  const fetchImpl = async (url, opts) => { capturedUrl = url; capturedHeaders = opts.headers; return jsonResponse({ codigo: 'DOK', descripcion: 'Documento Recibido por el SII. Datos Coinciden con los Registrados' }); };
  const client = new SiiBoletaLookupClient({ baseUrl: 'https://apicert.sii.cl/recursos/v1', fetchImpl });
  const result = await client.checkDocument({ token: 'fake-token-1234', issuerRut: '77808406-6', documentType: 39, folio: 46 });
  assert.equal(result.result, 'FOUND');
  assert.equal(result.codigo, 'DOK');
  assert.equal(capturedUrl, 'https://apicert.sii.cl/recursos/v1/boleta.electronica/77808406-6-39-46/estado');
  assert.equal(capturedHeaders.cookie, 'TOKEN=fake-token-1234');
});

test('checkDocument: codigo=FAU se traduce a NOT_FOUND', async () => {
  const fetchImpl = async () => jsonResponse({ codigo: 'FAU', descripcion: 'Documento No Recibido por el SII' });
  const client = new SiiBoletaLookupClient({ baseUrl: 'https://apicert.sii.cl/recursos/v1', fetchImpl });
  const result = await client.checkDocument({ token: 'fake-token-1234', issuerRut: '77808406-6', documentType: 39, folio: 47 });
  assert.equal(result.result, 'NOT_FOUND');
  assert.equal(result.codigo, 'FAU');
});

test('checkDocument: error de red nunca se traduce a NOT_FOUND, siempre UNKNOWN', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET simulado'); };
  const client = new SiiBoletaLookupClient({ baseUrl: 'https://apicert.sii.cl/recursos/v1', fetchImpl });
  const result = await client.checkDocument({ token: 'fake-token-1234', issuerRut: '77808406-6', documentType: 39, folio: 48 });
  assert.equal(result.result, 'UNKNOWN');
  assert.match(result.reason, /network_error/);
});

test('checkDocument: HTTP 404/500 del SII nunca se traduce a NOT_FOUND, siempre UNKNOWN', async () => {
  const fetchImpl404 = async () => jsonResponse('Recurso No Encontrado', { status: 404, contentType: 'text/plain' });
  const client404 = new SiiBoletaLookupClient({ baseUrl: 'https://apicert.sii.cl/recursos/v1', fetchImpl: fetchImpl404 });
  const r404 = await client404.checkDocument({ token: 'fake-token-1234', issuerRut: '77808406-6', documentType: 39, folio: 49 });
  assert.equal(r404.result, 'UNKNOWN');
  assert.equal(r404.httpStatus, 404);

  const fetchImpl500 = async () => jsonResponse('Error interno', { status: 500, contentType: 'text/plain' });
  const client500 = new SiiBoletaLookupClient({ baseUrl: 'https://apicert.sii.cl/recursos/v1', fetchImpl: fetchImpl500 });
  const r500 = await client500.checkDocument({ token: 'fake-token-1234', issuerRut: '77808406-6', documentType: 39, folio: 50 });
  assert.equal(r500.result, 'UNKNOWN');
});

test('checkDocument: respuesta no JSON nunca se traduce a NOT_FOUND, siempre UNKNOWN', async () => {
  const fetchImpl = async () => jsonResponse('<html>maintenance</html>', { status: 200, contentType: 'text/html' });
  const client = new SiiBoletaLookupClient({ baseUrl: 'https://apicert.sii.cl/recursos/v1', fetchImpl });
  const result = await client.checkDocument({ token: 'fake-token-1234', issuerRut: '77808406-6', documentType: 39, folio: 46 });
  assert.equal(result.result, 'UNKNOWN');
  assert.equal(result.reason, 'non_json_response');
});

test('checkDocuments: consulta varios folios en secuencia y conserva el orden', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return jsonResponse({ codigo: 'FAU', descripcion: '' }); };
  const client = new SiiBoletaLookupClient({ baseUrl: 'https://apicert.sii.cl/recursos/v1', fetchImpl });
  const results = await client.checkDocuments({ token: 'fake-token-1234', issuerRut: '77808406-6', documentType: 39, folios: [46, 47, 48, 49, 50] });
  assert.deepEqual(results.map((r) => r.folio), [46, 47, 48, 49, 50]);
  assert.equal(seen.length, 5);
});
