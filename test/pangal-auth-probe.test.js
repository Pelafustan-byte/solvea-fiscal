import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { probePangalAuthFetch, probePangalAuthHttps, diagnosePangalAuth, tokenFingerprint } from '../src/sii/pangal-auth-probe.js';

function fakeFetchResponse({ status, headers = {}, body = '', redirected = false, url = 'https://pangal.sii.cl/recursos/v1/boleta.electronica.envio' }) {
  return {
    status,
    redirected,
    url,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body
  };
}

test('tokenFingerprint: nunca expone el token, es un hash corto determinístico', () => {
  const fp = tokenFingerprint('super-secreto-real-123456789');
  assert.equal(fp.length, 12);
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.ok(!fp.includes('super-secreto'));
  assert.equal(fp, tokenFingerprint('super-secreto-real-123456789'), 'debe ser determinístico para el mismo token');
});

test('probePangalAuthFetch: el multipart NUNCA incluye el campo archivo (no puede registrar boleta)', async () => {
  let capturedForm = null;
  const fetchImpl = async (url, opts) => { capturedForm = opts.body; return fakeFetchResponse({ status: 401, body: 'NO ESTA AUTENTICADO\n', headers: { 'content-type': 'text/plain' } }); };
  const result = await probePangalAuthFetch({
    pangalBaseUrl: 'https://pangal.sii.cl/recursos/v1', token: 'fake-token-999', senderRut: '19105425-3', companyRut: '77808406-6', fetchImpl
  });
  assert.ok(capturedForm instanceof FormData);
  assert.equal(capturedForm.has('archivo'), false, 'jamás debe incluir el campo archivo');
  assert.equal(capturedForm.get('rutSender'), '19105425');
  assert.equal(capturedForm.get('dvSender'), '3');
  assert.equal(result.httpStatus, 401);
  assert.equal(result.contentType, 'text/plain');
  assert.equal(result.bodyPreview, 'NO ESTA AUTENTICADO\n');
  assert.equal(result.tokenPresent, true);
  assert.equal(result.tokenLength, 'fake-token-999'.length);
  assert.ok(!JSON.stringify(result).includes('fake-token-999'), 'el resultado no debe contener el token en texto plano');
});

test('probePangalAuthFetch: usa redirect:"manual" y detecta 3xx sin seguirlo', async () => {
  let capturedRedirectOption = null;
  const fetchImpl = async (url, opts) => {
    capturedRedirectOption = opts.redirect;
    return fakeFetchResponse({ status: 302, headers: { location: 'https://otro-host.example/', 'content-type': 'text/html' }, redirected: false });
  };
  const result = await probePangalAuthFetch({ pangalBaseUrl: 'https://pangal.sii.cl/recursos/v1', token: 'fake-token', senderRut: '19105425-3', companyRut: '77808406-6', fetchImpl });
  assert.equal(capturedRedirectOption, 'manual');
  assert.equal(result.redirected, true);
  assert.equal(result.location, 'https://otro-host.example/');
});

test('diagnosePangalAuth: si el fetch probe detecta redirección, se detiene y NO ejecuta el probe https.request', async () => {
  const fetchImpl = async () => fakeFetchResponse({ status: 302, headers: { location: 'https://otro-host.example/' } });
  let httpsCalled = false;
  const requestImpl = () => { httpsCalled = true; const emitter = new EventEmitter(); return emitter; };
  const result = await diagnosePangalAuth({ pangalBaseUrl: 'https://pangal.sii.cl/recursos/v1', token: 'fake-token', senderRut: '19105425-3', companyRut: '77808406-6', fetchImpl, requestImpl });
  assert.equal(result.stoppedOnRedirect, true);
  assert.equal(result.httpsProbe, null);
  assert.equal(httpsCalled, false);
});

function fakeHttpsRequestImpl({ statusCode, headers = {}, body = '', onOptions } = {}) {
  return (options, callback) => {
    if (onOptions) onOptions(options);
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headers = headers;
      callback(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
    };
    req.destroy = () => {};
    return req;
  };
}

test('probePangalAuthHttps: distingue 401 de 400 y nunca incluye archivo/XML', async () => {
  const requestImpl = fakeHttpsRequestImpl({ statusCode: 401, headers: { 'content-type': 'text/plain' }, body: 'NO ESTA AUTENTICADO\n' });
  const result = await probePangalAuthHttps({ pangalBaseUrl: 'https://pangal.sii.cl/recursos/v1', token: 'fake-token', senderRut: '19105425-3', companyRut: '77808406-6', requestImpl });
  assert.equal(result.httpStatus, 401);
  assert.equal(result.client, 'https.request');

  const requestImpl400 = fakeHttpsRequestImpl({ statusCode: 400, headers: { 'content-type': 'text/plain' }, body: 'archivo requerido\n' });
  const result400 = await probePangalAuthHttps({ pangalBaseUrl: 'https://pangal.sii.cl/recursos/v1', token: 'fake-token', senderRut: '19105425-3', companyRut: '77808406-6', requestImpl: requestImpl400 });
  assert.equal(result400.httpStatus, 400);
});

test('diagnosePangalAuth: mismo token en ambos probes, correlacionable sólo por fingerprint', async () => {
  const fetchImpl = async () => fakeFetchResponse({ status: 401, body: 'NO ESTA AUTENTICADO\n', headers: { 'content-type': 'text/plain' } });
  const requestImpl = fakeHttpsRequestImpl({ statusCode: 401, headers: { 'content-type': 'text/plain' }, body: 'NO ESTA AUTENTICADO\n' });
  const result = await diagnosePangalAuth({ pangalBaseUrl: 'https://pangal.sii.cl/recursos/v1', token: 'el-mismo-token-real', senderRut: '19105425-3', companyRut: '77808406-6', fetchImpl, requestImpl });
  assert.equal(result.fetchProbe.tokenFingerprint, result.httpsProbe.tokenFingerprint);
  assert.ok(!JSON.stringify(result).includes('el-mismo-token-real'));
});

test('probePangalAuthHttps: con cert/key envía TLS mutuo (mtls:true) y los reenvía al request nativo', async () => {
  let capturedOptions = null;
  const requestImpl = fakeHttpsRequestImpl({
    statusCode: 400, headers: { 'content-type': 'text/plain' }, body: 'archivo requerido\n',
    onOptions: (options) => { capturedOptions = options; }
  });
  const result = await probePangalAuthHttps({
    pangalBaseUrl: 'https://pangal.sii.cl/recursos/v1', token: 'fake-token', senderRut: '19105425-3', companyRut: '77808406-6',
    requestImpl, cert: 'CERT-PEM-FAKE', key: 'KEY-PEM-FAKE'
  });
  assert.equal(result.mtls, true);
  assert.equal(result.httpStatus, 400, 'si mTLS resuelve el 401, la siguiente barrera sería una validación de datos (400), no autenticación');
  assert.equal(capturedOptions.cert, 'CERT-PEM-FAKE');
  assert.equal(capturedOptions.key, 'KEY-PEM-FAKE');
});

test('probePangalAuthHttps: sin cert/key, mtls:false y no se envían opciones de certificado', async () => {
  let capturedOptions = null;
  const requestImpl = fakeHttpsRequestImpl({
    statusCode: 401, headers: { 'content-type': 'text/plain' }, body: 'NO ESTA AUTENTICADO\n',
    onOptions: (options) => { capturedOptions = options; }
  });
  const result = await probePangalAuthHttps({ pangalBaseUrl: 'https://pangal.sii.cl/recursos/v1', token: 'fake-token', senderRut: '19105425-3', companyRut: '77808406-6', requestImpl });
  assert.equal(result.mtls, false);
  assert.equal(capturedOptions.cert, undefined);
  assert.equal(capturedOptions.key, undefined);
});

test('diagnosePangalAuth: con cert/key corre un tercer probe httpsMtlsProbe además del par habitual', async () => {
  const fetchImpl = async () => fakeFetchResponse({ status: 401, body: 'NO ESTA AUTENTICADO\n', headers: { 'content-type': 'text/plain' } });
  const requestImpl = fakeHttpsRequestImpl({ statusCode: 401, headers: { 'content-type': 'text/plain' }, body: 'NO ESTA AUTENTICADO\n' });
  const result = await diagnosePangalAuth({
    pangalBaseUrl: 'https://pangal.sii.cl/recursos/v1', token: 'fake-token', senderRut: '19105425-3', companyRut: '77808406-6',
    fetchImpl, requestImpl, cert: 'CERT-PEM-FAKE', key: 'KEY-PEM-FAKE'
  });
  assert.ok(result.httpsMtlsProbe);
  assert.equal(result.httpsMtlsProbe.mtls, true);
});

test('diagnosePangalAuth: sin cert/key, httpsMtlsProbe es null (no intenta mTLS por accidente)', async () => {
  const fetchImpl = async () => fakeFetchResponse({ status: 401, body: 'NO ESTA AUTENTICADO\n', headers: { 'content-type': 'text/plain' } });
  const requestImpl = fakeHttpsRequestImpl({ statusCode: 401, headers: { 'content-type': 'text/plain' }, body: 'NO ESTA AUTENTICADO\n' });
  const result = await diagnosePangalAuth({ pangalBaseUrl: 'https://pangal.sii.cl/recursos/v1', token: 'fake-token', senderRut: '19105425-3', companyRut: '77808406-6', fetchImpl, requestImpl });
  assert.equal(result.httpsMtlsProbe, null);
});
