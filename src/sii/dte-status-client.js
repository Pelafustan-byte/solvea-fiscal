// Cliente de consulta de estado final de un envío DTE (QueryEstUp) — protocolo verificado
// contra el manual oficial "Consulta de Estado de Upload Dte" (OI2004_CEUPDTE_MDE_1.10,
// sii.cl/factura_electronica/factura_mercado/estado_envio.pdf). Es un webservice SOAP 1.1
// (no REST/JSON como boleta-lookup-client.js), ubicado en
// https://maullin.sii.cl/DTEWS/QueryEstUp.jws (certificación) /
// https://palena.sii.cl/DTEWS/QueryEstUp.jws (producción).
//
// Nota sobre el request: el WSDL del servicio (wsdl:message "getEstUpRequest") declara los
// parámetros como RutCompania/DvCompania/TrackId/Token, pero el propio manual, en su "Ejemplo
// REAL de Parámetros de Entrada" (punto 3.1.1), usa los nombres de elemento Rut/Dv/TrackId/Token
// en el cuerpo SOAP. Seguimos el ejemplo real (es el que el manual marca explícitamente como
// funcional), no el nombre abstracto del WSDL.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DOMParser } = require('@xmldom/xmldom');
const xpath = require('xpath');

// Estados documentados en el manual — nunca inventar estados nuevos.
const ESTADO_GLOSA = {
  RSC: 'Rechazado por Error en Schema',
  SOK: 'Schema Validado',
  CRT: 'Caratula OK',
  RFR: 'Rechazado por Error en Firma',
  FOK: 'Firma de Envío Validada',
  PDR: 'Envío en Proceso',
  RCT: 'Rechazado por Error en Carátula',
  EPR: 'Envío Procesado',
  '001': 'Cookie Inactivo (o Token Inactivo)',
  '002': 'Token Inactivo',
  '003': 'Token No Existe'
};

function httpError(status, message, detail = {}) {
  const error = new Error(message);
  error.status = status;
  error.detail = detail;
  return error;
}

function validToken(token) {
  const value = String(token || '').trim();
  if (!/^[A-Za-z0-9._-]{8,512}$/.test(value)) throw httpError(422, 'Token SII inválido.');
  return value;
}

function sanitizedBodyPreview(body) {
  return String(body || '').slice(0, 1000);
}

function textOf(doc, tagName) {
  const node = xpath.select(`//*[local-name(.)='${tagName}']`, doc)[0];
  return node ? String(node.textContent || '').trim() : '';
}

function intOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildSoapEnvelope({ rut, dv, trackId, token }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<SOAP-ENV:Body>` +
    `<m:getEstUp xmlns:m="https://maullin.sii.cl/DTEWS/QueryEstUp.jws">` +
    `<Rut xsi:type="xsd:string">${rut}</Rut>` +
    `<Dv xsi:type="xsd:string">${dv}</Dv>` +
    `<TrackId xsi:type="xsd:string">${trackId}</TrackId>` +
    `<Token xsi:type="xsd:string">${token}</Token>` +
    `</m:getEstUp>` +
    `</SOAP-ENV:Body>` +
    `</SOAP-ENV:Envelope>`;
}

/**
 * El SOAP response envuelve el XML de verdad como texto escapado dentro de
 * <getEstUpReturn>&lt;SII:RESPUESTA&gt;...&lt;/SII:RESPUESTA&gt;</getEstUpReturn> — el parser
 * XML ya des-escapa las entidades al leer el textContent, así que sólo hace falta
 * re-parsear ese string como un segundo documento XML.
 */
function parseQueryEstUpResponse(body) {
  const outer = new DOMParser().parseFromString(body, 'text/xml');
  const returnNode = xpath.select("//*[local-name(.)='getEstUpReturn']", outer)[0];
  const innerXml = returnNode ? String(returnNode.textContent || '').trim() : '';
  if (!innerXml) return null;
  const inner = new DOMParser().parseFromString(innerXml, 'text/xml');
  const estado = textOf(inner, 'ESTADO');
  return {
    trackId: textOf(inner, 'TRACKID'),
    estado,
    estadoMessage: ESTADO_GLOSA[estado] || '',
    glosa: textOf(inner, 'GLOSA'),
    numAtencion: textOf(inner, 'NUM_ATENCION'),
    errCode: textOf(inner, 'ERR_CODE'),
    sqlCode: textOf(inner, 'SQL_CODE'),
    srvCode: textOf(inner, 'SRV_CODE'),
    tipoDocto: intOrNull(textOf(inner, 'TIPO_DOCTO')),
    informados: intOrNull(textOf(inner, 'INFORMADOS')),
    aceptados: intOrNull(textOf(inner, 'ACEPTADOS')),
    rechazados: intOrNull(textOf(inner, 'RECHAZADOS')),
    reparos: intOrNull(textOf(inner, 'REPAROS'))
  };
}

export function dteStatusBaseUrlForMode(mode) {
  return mode === 'production' ? 'https://palena.sii.cl' : 'https://maullin.sii.cl';
}

export class SiiDteStatusClient {
  constructor({ baseUrl, requestImpl, timeoutMs = 20_000 }) {
    if (!baseUrl) throw new Error('baseUrl de consulta de estado DTE es obligatorio.');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.requestImpl = requestImpl;
    this.timeoutMs = timeoutMs;
  }

  async checkUpload({ token, companyRut, trackId }) {
    const authToken = validToken(token);
    const track = String(trackId || '').trim();
    if (!/^\d{1,10}$/.test(track)) throw httpError(422, 'TrackId inválido.');
    const match = String(companyRut || '').replace(/\./g, '').match(/^(\d+)-([0-9Kk])$/);
    if (!match) throw httpError(422, `RUT inválido: ${companyRut || '(vacío)'}.`);
    const [, rut, dv] = match;
    if (!this.requestImpl) throw httpError(503, 'requestImpl es obligatorio (no se puede consultar sin cliente HTTP inyectado).');

    const envelope = buildSoapEnvelope({ rut, dv: dv.toUpperCase(), trackId: track, token: authToken });
    const body = Buffer.from(envelope, 'utf8');
    const url = new URL(`${this.baseUrl}/DTEWS/QueryEstUp.jws`);

    return new Promise((resolve, reject) => {
      const req = this.requestImpl({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          accept: 'text/xml',
          'content-type': 'text/xml; charset=utf-8',
          soapaction: '',
          'user-agent': 'SOLVEA-Fiscal/0.7',
          'content-length': body.length
        },
        timeout: this.timeoutMs
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(httpError(502, `SII respondió HTTP ${res.statusCode} en QueryEstUp.`, {
              httpStatus: res.statusCode, bodyPreview: sanitizedBodyPreview(data), endpoint: '/DTEWS/QueryEstUp.jws', timestamp: new Date().toISOString()
            }));
          }
          const parsed = parseQueryEstUpResponse(data);
          if (!parsed) {
            return reject(httpError(502, 'SII no devolvió getEstUpReturn válido.', {
              httpStatus: res.statusCode, bodyPreview: sanitizedBodyPreview(data), endpoint: '/DTEWS/QueryEstUp.jws', timestamp: new Date().toISOString()
            }));
          }
          resolve(parsed);
        });
      });
      req.on('error', (error) => reject(httpError(502, `Error de red en QueryEstUp: ${error.message}`, { endpoint: '/DTEWS/QueryEstUp.jws' })));
      req.on('timeout', () => { req.destroy(); reject(httpError(504, 'Timeout en QueryEstUp.', { endpoint: '/DTEWS/QueryEstUp.jws' })); });
      req.write(body);
      req.end();
    });
  }
}
