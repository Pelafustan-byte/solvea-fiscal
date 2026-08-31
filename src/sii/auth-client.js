import { createRequire } from 'node:module';
import { signSeedXml } from './seed-signature.js';

const require = createRequire(import.meta.url);
const xpath = require('xpath');
const { DOMParser } = require('@xmldom/xmldom');

function httpError(status, message, detail = {}) {
  const error = new Error(message);
  error.status = status;
  error.detail = detail;
  return error;
}

function textByLocalName(xml, localName) {
  const doc = new DOMParser().parseFromString(String(xml), 'text/xml');
  const nodes = xpath.select(`//*[local-name(.)='${localName}']`, doc);
  return nodes[0]?.textContent?.trim() || '';
}

function parseSiiXml(xml, expectedField) {
  const estado = textByLocalName(xml, 'ESTADO');
  const value = textByLocalName(xml, expectedField);
  const glosa = textByLocalName(xml, 'GLOSA') || textByLocalName(xml, 'ERR_CODE') || '';
  if (!value) throw httpError(502, `Respuesta SII sin ${expectedField}.`, { estado, glosa });
  if (estado && !['0', '00'].includes(estado)) throw httpError(502, `SII rechazó la operación de autenticación (estado ${estado}).`, { estado, glosa });
  return { value, estado: estado || '0', glosa };
}

async function responseText(response) {
  const body = await response.text();
  if (!response.ok) {
    throw httpError(502, `SII respondió HTTP ${response.status}.`, { status: response.status, body: body.slice(0, 1000) });
  }
  return body;
}

export class SiiAuthClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    if (!baseUrl) throw new Error('baseUrl de autenticación SII es obligatorio.');
    if (typeof fetchImpl !== 'function') throw new Error('fetchImpl es obligatorio.');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async getSeed() {
    const response = await this.fetch(`${this.baseUrl}/boleta.electronica.semilla`, {
      method: 'GET',
      headers: { accept: 'application/xml' },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const xml = await responseText(response);
    const parsed = parseSiiXml(xml, 'SEMILLA');
    if (!/^\d{1,32}$/.test(parsed.value)) throw httpError(502, 'SII devolvió una semilla con formato inesperado.');
    return { seed: parsed.value, rawXml: xml, estado: parsed.estado };
  }

  async getToken(signedSeedXml) {
    const response = await this.fetch(`${this.baseUrl}/boleta.electronica.token`, {
      method: 'POST',
      headers: { accept: 'application/xml', 'content-type': 'application/xml; charset=utf-8' },
      body: String(signedSeedXml),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const xml = await responseText(response);
    const parsed = parseSiiXml(xml, 'TOKEN');
    if (!/^[A-Za-z0-9._-]{8,512}$/.test(parsed.value)) throw httpError(502, 'SII devolvió un token con formato inesperado.');
    return { token: parsed.value, rawXml: xml, estado: parsed.estado };
  }

  async authenticate(credentials) {
    const seedResponse = await this.getSeed();
    const signed = signSeedXml({ seed: seedResponse.seed, credentials });
    const tokenResponse = await this.getToken(signed.xml);
    return {
      token: tokenResponse.token,
      seed: seedResponse.seed,
      signedSeedVerified: signed.verified,
      obtainedAt: new Date().toISOString()
    };
  }
}

export function authBaseUrlForMode(mode) {
  if (mode === 'production') return 'https://api.sii.cl/recursos/v1';
  return 'https://apicert.sii.cl/recursos/v1';
}
