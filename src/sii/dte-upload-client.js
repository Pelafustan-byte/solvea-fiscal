// Cliente del envío real de DTE (Factura/NC/ND) al SII — protocolo verificado contra el
// manual oficial "Envío Automático Documentos Tributarios Electrónicos" (OI2003_UPDTE_MDE_1.5,
// sii.cl/factura_electronica/factura_mercado/envio.pdf). Distinto del envío de Boleta
// (pangal.sii.cl, JSON): este es un upload clásico multipart/form-data (RFC1867) que responde
// XML síncrono <RECEPCIONDTE>. No modifica boleta-client.js.
import { createRequire } from 'node:module';
import { splitRut } from './envio-dte.js';

const require = createRequire(import.meta.url);
const { DOMParser } = require('@xmldom/xmldom');
const xpath = require('xpath');

// Tabla de STATUS oficial del manual — nunca inventar códigos nuevos.
const STATUS_MESSAGES = {
  0: 'Upload OK',
  1: 'El Sender no tiene permiso para enviar',
  2: 'Error en tamaño del archivo (muy grande o muy chico)',
  3: 'Archivo cortado (tamaño <> al parámetro size)',
  5: 'No está autenticado',
  6: 'Empresa no autorizada a enviar archivos',
  7: 'Esquema Invalido',
  8: 'Firma del Documento',
  9: 'Sistema Bloqueado'
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
  // Sólo texto de respuesta del SII (RECEPCIONDTE/DETAIL), nunca datos de nuestra propia
  // petición: no puede contener token/cookie/PFX/CAF nuestros. Se trunca a 1000 caracteres.
  return String(body || '').slice(0, 1000);
}

function textOf(doc, tagName) {
  const node = xpath.select(`//*[local-name(.)='${tagName}']`, doc)[0];
  return node ? String(node.textContent || '').trim() : '';
}

function parseRecepcionDte(body) {
  const doc = new DOMParser().parseFromString(body, 'text/xml');
  const root = xpath.select("//*[local-name(.)='RECEPCIONDTE']", doc)[0];
  if (!root) return null;
  const statusRaw = textOf(doc, 'STATUS');
  const status = /^\d+$/.test(statusRaw) ? Number(statusRaw) : null;
  const errors = xpath.select("//*[local-name(.)='DETAIL']//*[local-name(.)='ERROR']", doc)
    .map((node) => String(node.textContent || '').trim())
    .filter(Boolean);
  return {
    rutSender: textOf(doc, 'RUTSENDER'),
    rutCompany: textOf(doc, 'RUTCOMPANY'),
    file: textOf(doc, 'FILE'),
    receivedAt: textOf(doc, 'TIMESTAMP'),
    status,
    statusMessage: status !== null ? (STATUS_MESSAGES[status] || 'Error Interno') : '',
    trackId: textOf(doc, 'TRACKID'),
    errors
  };
}

export function dteUploadBaseUrlForMode(mode) {
  return mode === 'production' ? 'https://palena.sii.cl' : 'https://maullin.sii.cl';
}

function multipartFieldPart(boundary, name, value) {
  return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

function multipartFilePart(boundary, name, filename, contentType, content) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`, 'utf8'),
    Buffer.from(content, 'latin1'),
    Buffer.from('\r\n', 'utf8')
  ]);
}

export class SiiDteUploadClient {
  constructor({ baseUrl, requestImpl, timeoutMs = 30_000 }) {
    if (!baseUrl) throw new Error('baseUrl de envío DTE es obligatorio.');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.requestImpl = requestImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Envía un sobre EnvioDTE (ya firmado) vía POST /cgi_dte/UPL/DTEUpload, protocolo
   * multipart/form-data (RFC1867) verificado contra el manual oficial. requestImpl debe
   * tener la forma de node:https.request (inyectable para tests, nunca golpea un host
   * real salvo que se le pase el módulo https real explícitamente).
   */
  async submit({ token, senderRut, companyRut, xml, filename = 'envioDte.xml' }) {
    const sender = splitRut(senderRut);
    const company = splitRut(companyRut);
    const authToken = validToken(token);
    const rawXml = String(xml || '');
    if (!rawXml.includes('<EnvioDTE')) throw httpError(422, 'El archivo no contiene EnvioDTE.');
    if (!this.requestImpl) throw httpError(503, 'requestImpl es obligatorio (no se puede enviar sin cliente HTTP inyectado).');

    const boundary = `----solveaFiscalDte${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(multipartFieldPart(boundary, 'rutSender', sender.body), 'utf8'),
      Buffer.from(multipartFieldPart(boundary, 'dvSender', sender.dv), 'utf8'),
      Buffer.from(multipartFieldPart(boundary, 'rutCompany', company.body), 'utf8'),
      Buffer.from(multipartFieldPart(boundary, 'dvCompany', company.dv), 'utf8'),
      multipartFilePart(boundary, 'archivo', filename, 'text/xml', rawXml),
      Buffer.from(`--${boundary}--\r\n`, 'utf8')
    ]);
    const url = new URL(`${this.baseUrl}/cgi_dte/UPL/DTEUpload`);

    return new Promise((resolve, reject) => {
      const req = this.requestImpl({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          accept: 'application/xml, text/xml, */*',
          cookie: `TOKEN=${authToken}`,
          'user-agent': 'SOLVEA-Fiscal/0.7',
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': body.length
        },
        timeout: this.timeoutMs
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(httpError(502, `SII respondió HTTP ${res.statusCode} en envío DTE.`, {
              httpStatus: res.statusCode, bodyPreview: sanitizedBodyPreview(data), endpoint: '/cgi_dte/UPL/DTEUpload', timestamp: new Date().toISOString()
            }));
          }
          const parsed = parseRecepcionDte(data);
          if (!parsed) {
            return reject(httpError(502, 'SII no devolvió RECEPCIONDTE válido.', {
              httpStatus: res.statusCode, bodyPreview: sanitizedBodyPreview(data), endpoint: '/cgi_dte/UPL/DTEUpload', timestamp: new Date().toISOString()
            }));
          }
          resolve(parsed);
        });
      });
      req.on('error', (error) => reject(httpError(502, `Error de red en envío DTE: ${error.message}`, { endpoint: '/cgi_dte/UPL/DTEUpload' })));
      req.on('timeout', () => { req.destroy(); reject(httpError(504, 'Timeout en envío DTE.', { endpoint: '/cgi_dte/UPL/DTEUpload' })); });
      req.write(body);
      req.end();
    });
  }
}
