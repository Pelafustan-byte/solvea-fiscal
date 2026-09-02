import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SiiDteUploadClient, dteUploadBaseUrlForMode } from '../src/sii/dte-upload-client.js';

function fakeRequestImpl({ statusCode = 200, body = '', onRequest } = {}) {
  return (options, callback) => {
    const req = new EventEmitter();
    let written = Buffer.alloc(0);
    req.write = (chunk) => { written = Buffer.concat([written, Buffer.from(chunk)]); };
    req.end = () => {
      if (onRequest) onRequest({ options, body: written });
      const res = new EventEmitter();
      res.statusCode = statusCode;
      callback(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
    };
    req.destroy = () => {};
    return req;
  };
}

function recepcionDte({ status, trackId = '', errors = [] }) {
  const detail = errors.length ? `<DETAIL>${errors.map((e) => `<ERROR>${e}</ERROR>`).join('')}</DETAIL>` : '';
  const trackTag = trackId ? `<TRACKID>${trackId}</TRACKID>` : '';
  return `<?xml version="1.0" ?><RECEPCIONDTE><RUTSENDER>19105425-3</RUTSENDER><RUTCOMPANY>77808406-6</RUTCOMPANY><FILE>envio.xml</FILE><TIMESTAMP>2026-08-31 20:45:00</TIMESTAMP><STATUS>${status}</STATUS>${detail}${trackTag}</RECEPCIONDTE>`;
}

test('dteUploadBaseUrlForMode distingue certificación de producción', () => {
  assert.equal(dteUploadBaseUrlForMode('certification'), 'https://maullin.sii.cl');
  assert.equal(dteUploadBaseUrlForMode('production'), 'https://palena.sii.cl');
});

test('submit() envía multipart con los 4 campos + archivo y Cookie TOKEN, POST a /cgi_dte/UPL/DTEUpload', async () => {
  let captured = null;
  const requestImpl = fakeRequestImpl({
    statusCode: 200,
    body: recepcionDte({ status: 0, trackId: '532' }),
    onRequest: (c) => { captured = c; }
  });
  const client = new SiiDteUploadClient({ baseUrl: 'https://maullin.sii.cl', requestImpl });
  const result = await client.submit({
    token: 'TOKEN123456', senderRut: '19105425-3', companyRut: '77808406-6',
    xml: '<?xml version="1.0"?><EnvioDTE version="1.0"></EnvioDTE>', filename: 'factura-33-1.xml'
  });

  assert.equal(captured.options.path, '/cgi_dte/UPL/DTEUpload');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.cookie, 'TOKEN=TOKEN123456');
  const bodyText = captured.body.toString('latin1');
  assert.match(bodyText, /name="rutSender"\r\n\r\n19105425\r\n/);
  assert.match(bodyText, /name="dvSender"\r\n\r\n3\r\n/);
  assert.match(bodyText, /name="rutCompany"\r\n\r\n77808406\r\n/);
  assert.match(bodyText, /name="dvCompany"\r\n\r\n6\r\n/);
  assert.match(bodyText, /name="archivo"; filename="factura-33-1\.xml"/);
  assert.match(bodyText, /<EnvioDTE version="1\.0">/);

  assert.equal(result.status, 0);
  assert.equal(result.statusMessage, 'Upload OK');
  assert.equal(result.trackId, '532');
  assert.equal(result.errors.length, 0);
});

test('submit() clasifica cada STATUS documentado (1, 5, 6, 9) sin inventar códigos', async () => {
  const cases = [
    [1, 'El Sender no tiene permiso para enviar'],
    [5, 'No está autenticado'],
    [6, 'Empresa no autorizada a enviar archivos'],
    [9, 'Sistema Bloqueado']
  ];
  for (const [status, message] of cases) {
    const requestImpl = fakeRequestImpl({ statusCode: 200, body: recepcionDte({ status }) });
    const client = new SiiDteUploadClient({ baseUrl: 'https://maullin.sii.cl', requestImpl });
    const result = await client.submit({
      token: 'TOKEN123456', senderRut: '19105425-3', companyRut: '77808406-6',
      xml: '<EnvioDTE version="1.0"></EnvioDTE>'
    });
    assert.equal(result.status, status);
    assert.equal(result.statusMessage, message);
  }
});

test('submit() con STATUS 7 (esquema inválido) conserva el detalle de errores exacto del SII', async () => {
  const errors = [
    'LSX-00265: attribute "version" value "3.2" is wrong (must be ".2")',
    'LSX-00213: only 0 occurrences of particle "sequence", minimum is 1'
  ];
  const requestImpl = fakeRequestImpl({ statusCode: 200, body: recepcionDte({ status: 7, errors }) });
  const client = new SiiDteUploadClient({ baseUrl: 'https://maullin.sii.cl', requestImpl });
  const result = await client.submit({
    token: 'TOKEN123456', senderRut: '19105425-3', companyRut: '77808406-6',
    xml: '<EnvioDTE version="1.0"></EnvioDTE>'
  });
  assert.equal(result.status, 7);
  assert.equal(result.statusMessage, 'Esquema Invalido');
  assert.deepEqual(result.errors, errors);
  assert.equal(result.trackId, '');
});

test('submit() nunca expone el token en el resultado ni en un error', async () => {
  const requestImpl = fakeRequestImpl({ statusCode: 500, body: 'Internal Server Error' });
  const client = new SiiDteUploadClient({ baseUrl: 'https://maullin.sii.cl', requestImpl });
  await assert.rejects(
    client.submit({ token: 'el-token-secreto-999', senderRut: '19105425-3', companyRut: '77808406-6', xml: '<EnvioDTE version="1.0"></EnvioDTE>' }),
    (error) => {
      assert.ok(!JSON.stringify(error.detail).includes('el-token-secreto-999'));
      return true;
    }
  );
});

test('submit() rechaza un XML que no contenga EnvioDTE (nunca envía factura/DTE/CAF por error)', async () => {
  const client = new SiiDteUploadClient({ baseUrl: 'https://maullin.sii.cl', requestImpl: fakeRequestImpl({}) });
  await assert.rejects(
    client.submit({ token: 'TOKEN123456', senderRut: '19105425-3', companyRut: '77808406-6', xml: '<EnvioBOLETA version="1.0"></EnvioBOLETA>' }),
    /EnvioDTE/
  );
});
