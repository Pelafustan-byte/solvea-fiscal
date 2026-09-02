import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SiiDteStatusClient, dteStatusBaseUrlForMode } from '../src/sii/dte-status-client.js';

function fakeRequestImpl({ statusCode = 200, body = '', onRequest } = {}) {
  return (options, callback) => {
    const req = new EventEmitter();
    let written = Buffer.alloc(0);
    req.write = (chunk) => { written = Buffer.concat([written, Buffer.from(chunk)]); };
    req.end = () => {
      if (onRequest) onRequest({ options, body: written.toString('utf8') });
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

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function soapResponse(innerXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Body><ns1:getEstUpResponse xmlns:ns1="https://maullin.sii.cl/DTEWS/QueryEstUp.jws">` +
    `<getEstUpReturn xsi:type="xsd:string">${escapeXml(innerXml)}</getEstUpReturn>` +
    `</ns1:getEstUpResponse></soapenv:Body></soapenv:Envelope>`;
}

test('dteStatusBaseUrlForMode distingue certificación de producción', () => {
  assert.equal(dteStatusBaseUrlForMode('certification'), 'https://maullin.sii.cl');
  assert.equal(dteStatusBaseUrlForMode('production'), 'https://palena.sii.cl');
});

test('checkUpload() envía el sobre SOAP correcto (Rut/Dv/TrackId/Token) a QueryEstUp.jws', async () => {
  let captured = null;
  const inner = `<?xml version="1.0" ?><SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema"><SII:RESP_HDR><TRACKID>532</TRACKID><ESTADO>CRT</ESTADO><GLOSA>Caratula OK</GLOSA><NUM_ATENCION>532 ( 2026/08/31 16:44:20)</NUM_ATENCION></SII:RESP_HDR></SII:RESPUESTA>`;
  const requestImpl = fakeRequestImpl({ statusCode: 200, body: soapResponse(inner), onRequest: (c) => { captured = c; } });
  const client = new SiiDteStatusClient({ baseUrl: 'https://maullin.sii.cl', requestImpl });

  const result = await client.checkUpload({ token: 'TOKEN123456', companyRut: '77808406-6', trackId: '532' });

  assert.equal(captured.options.path, '/DTEWS/QueryEstUp.jws');
  assert.equal(captured.options.method, 'POST');
  assert.match(captured.body, /<Rut xsi:type="xsd:string">77808406<\/Rut>/);
  assert.match(captured.body, /<Dv xsi:type="xsd:string">6<\/Dv>/);
  assert.match(captured.body, /<TrackId xsi:type="xsd:string">532<\/TrackId>/);
  assert.match(captured.body, /<Token xsi:type="xsd:string">TOKEN123456<\/Token>/);

  assert.equal(result.trackId, '532');
  assert.equal(result.estado, 'CRT');
  assert.equal(result.estadoMessage, 'Caratula OK');
});

test('checkUpload() EPR (envío procesado) expone Informados/Aceptados/Rechazados/Reparos', async () => {
  const inner = `<SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema"><SII:RESP_HDR><TRACKID>251</TRACKID><ESTADO>EPR</ESTADO><GLOSA>Envio Procesado</GLOSA><NUM_ATENCION>532 ( 2026/08/31 16:44:20)</NUM_ATENCION></SII:RESP_HDR><SII:RESP_BODY><TIPO_DOCTO>33</TIPO_DOCTO><INFORMADOS>1</INFORMADOS><ACEPTADOS>1</ACEPTADOS><RECHAZADOS>0</RECHAZADOS><REPAROS>0</REPAROS></SII:RESP_BODY></SII:RESPUESTA>`;
  const requestImpl = fakeRequestImpl({ statusCode: 200, body: soapResponse(inner) });
  const client = new SiiDteStatusClient({ baseUrl: 'https://maullin.sii.cl', requestImpl });

  const result = await client.checkUpload({ token: 'TOKEN123456', companyRut: '77808406-6', trackId: '251' });

  assert.equal(result.estado, 'EPR');
  assert.equal(result.tipoDocto, 33);
  assert.equal(result.informados, 1);
  assert.equal(result.aceptados, 1);
  assert.equal(result.rechazados, 0);
  assert.equal(result.reparos, 0);
});

test('checkUpload() clasifica errores de autenticación de token (001/002/003) sin inventarlos', async () => {
  const cases = [
    ['001', 'COOKIE INACTIVO', 'Cookie Inactivo (o Token Inactivo)'],
    ['002', 'TOKEN+INACTIVO', 'Token Inactivo'],
    ['003', 'NO+EXISTE', 'Token No Existe']
  ];
  for (const [estado, glosa, message] of cases) {
    const inner = `<SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema"><SII:RESP_HDR><ESTADO>${estado}</ESTADO><GLOSA>${glosa}</GLOSA></SII:RESP_HDR></SII:RESPUESTA>`;
    const requestImpl = fakeRequestImpl({ statusCode: 200, body: soapResponse(inner) });
    const client = new SiiDteStatusClient({ baseUrl: 'https://maullin.sii.cl', requestImpl });
    const result = await client.checkUpload({ token: 'TOKEN123456', companyRut: '77808406-6', trackId: '1' });
    assert.equal(result.estado, estado);
    assert.equal(result.estadoMessage, message);
  }
});

test('checkUpload() nunca expone el token en el resultado ni en un error', async () => {
  const requestImpl = fakeRequestImpl({ statusCode: 500, body: 'Internal Server Error' });
  const client = new SiiDteStatusClient({ baseUrl: 'https://maullin.sii.cl', requestImpl });
  await assert.rejects(
    client.checkUpload({ token: 'el-token-secreto-999', companyRut: '77808406-6', trackId: '1' }),
    (error) => {
      assert.ok(!JSON.stringify(error.detail).includes('el-token-secreto-999'));
      return true;
    }
  );
});
