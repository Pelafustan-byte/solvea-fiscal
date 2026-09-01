// Consulta de Boleta Electrónica por folio — servicio oficial SII, verificado contra el
// OpenAPI 3.0.1 real publicado en https://www4c.sii.cl/bolcoreinternetui/api/openapi.yaml
// (title: "API SII - V1", version 1.0.5). No se inventaron rutas, parámetros ni respuesta.
//
// Endpoint exacto del spec:
//   GET /boleta.electronica/{rut}-{dv}-{tipo}-{folio}/estado
//   servers: apicert.sii.cl (certificación) — pangal.sii.cl queda documentado en el spec
//   como "(Temporal) exclusivo envio (POST /boleta.electronica.envio)", por lo que esta
//   consulta usa el servidor de recursos general (el mismo que autenticación), no pangal.
//   security: TOKEN (apiKey, name: Cookie, in: header) — mismo esquema "cookie: TOKEN=..."
//   ya usado en boleta-client.js.
//
// Respuesta 200 (EstadoBoletaRespuesta): { codigo, descripcion }
//   codigo enum documentado: DOK, DNK, FAU, FNA, FAN, EMP, TMD, TMC, MMD, MMC, AND, ANC
//     DOK = Documento Recibido por el SII. Datos Coinciden con los Registrados.
//     DNK = Documento Recibido por el SII pero Datos NO Coinciden con los registrados.
//     FAU = Documento No Recibido por el SII.
//     FNA = Documento No Autorizado.
//     FAN = Documento Anulado.
//     EMP = Empresa No Autorizada a Emitir Documentos Tributarios Electronicos.
//     TMD/TMC/MMD/MMC/AND/ANC = el documento original existe y fue modificado/anulado por
//       una nota de crédito o débito posterior.
// Errores: 400/401/404/405/500 devuelven texto plano (schema Error: string), no JSON.

import { splitRut } from './envio-boleta.js';

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

// Códigos que implican que el SII SÍ tiene registro del documento (recibido, coincida o
// no la info de contraste, o modificado/anulado posteriormente por NC/ND).
const FOUND_CODES = new Set(['DOK', 'DNK', 'FAN', 'TMD', 'TMC', 'MMD', 'MMC', 'AND', 'ANC']);
// Códigos que son una negativa explícita y específica del documento consultado.
const NOT_FOUND_CODES = new Set(['FAU', 'FNA']);
// EMP describe un problema de autorización de la EMPRESA, no de este folio puntual: no
// permite concluir nada sobre el folio -> UNKNOWN, nunca se traduce a NOT_FOUND.

export function classifyEstadoBoletaCodigo(codigo) {
  const code = String(codigo || '').trim().toUpperCase();
  if (FOUND_CODES.has(code)) return 'FOUND';
  if (NOT_FOUND_CODES.has(code)) return 'NOT_FOUND';
  return 'UNKNOWN';
}

export class SiiBoletaLookupClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
    if (!baseUrl) throw new Error('baseUrl de consulta de boletas SII es obligatorio.');
    if (typeof fetchImpl !== 'function') throw new Error('fetchImpl es obligatorio.');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Consulta UN folio, sin reservar ni modificar nada. Nunca lanza por una respuesta de
   * negocio (200 con codigo=FAU, etc.) — sólo por errores de validación de entrada. Ante
   * cualquier problema técnico (HTTP != 200, timeout, red, cuerpo no parseable) devuelve
   * result:'UNKNOWN', nunca 'NOT_FOUND'.
   */
  async checkDocument({ token, issuerRut, documentType, folio }) {
    const authToken = validToken(token);
    const issuer = splitRut(issuerRut);
    const tipo = Number(documentType);
    const folioNum = Number(folio);
    if (!Number.isInteger(tipo) || tipo <= 0) throw httpError(422, 'documentType inválido.');
    if (!Number.isInteger(folioNum) || folioNum <= 0) throw httpError(422, 'folio inválido.');

    const path = `/boleta.electronica/${issuer.body}-${issuer.dv}-${tipo}-${folioNum}/estado`;
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', cookie: `TOKEN=${authToken}`, 'user-agent': 'SOLVEA-Fiscal/0.7' },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      return { folio: folioNum, result: 'UNKNOWN', codigo: '', descripcion: '', httpStatus: null, reason: `network_error: ${error.message}` };
    }

    const contentType = response.headers.get('content-type') || '';
    const bodyText = await response.text().catch(() => '');

    if (!response.ok) {
      return {
        folio: folioNum, result: 'UNKNOWN', codigo: '', descripcion: '',
        httpStatus: response.status, reason: `http_${response.status}`,
        bodyPreview: bodyText.slice(0, 1000)
      };
    }

    let data;
    try {
      data = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      return {
        folio: folioNum, result: 'UNKNOWN', codigo: '', descripcion: '',
        httpStatus: response.status, reason: 'non_json_response',
        contentType, bodyPreview: bodyText.slice(0, 1000)
      };
    }

    const codigo = String(data?.codigo || '').trim().toUpperCase();
    const descripcion = String(data?.descripcion || '').trim();
    return { folio: folioNum, result: classifyEstadoBoletaCodigo(codigo), codigo, descripcion, httpStatus: response.status };
  }

  /**
   * Consulta varios folios en secuencia (no en paralelo, para no disparar rate limiting del
   * SII — la respuesta ya trae headers X-RateLimit-*). Nunca reserva ni envía nada.
   */
  async checkDocuments({ token, issuerRut, documentType, folios }) {
    const results = [];
    for (const folio of folios) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.checkDocument({ token, issuerRut, documentType, folio }));
    }
    return results;
  }
}
