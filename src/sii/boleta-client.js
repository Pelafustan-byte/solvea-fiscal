import { splitRut } from './envio-boleta.js';

function httpError(status, message, detail = {}) {
  const error = new Error(message);
  error.status = status;
  error.detail = detail;
  return error;
}

async function parseResponse(response) {
  const body = await response.text();
  let data;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    throw httpError(502, 'SII respondió contenido no JSON en API de boletas.', { status: response.status, body: body.slice(0, 1000) });
  }
  if (!response.ok) throw httpError(502, `SII respondió HTTP ${response.status}.`, { status: response.status, data });
  return data;
}

function validToken(token) {
  const value = String(token || '').trim();
  if (!/^[A-Za-z0-9._-]{8,512}$/.test(value)) throw httpError(422, 'Token SII inválido.');
  return value;
}

export function boletaBaseUrlForMode(mode) {
  return mode === 'production' ? 'https://rahue.sii.cl/recursos/v1' : 'https://pangal.sii.cl/recursos/v1';
}

export class SiiBoletaClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
    if (!baseUrl) throw new Error('baseUrl de boletas SII es obligatorio.');
    if (typeof fetchImpl !== 'function') throw new Error('fetchImpl es obligatorio.');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async submit({ token, senderRut, companyRut, xml, filename = 'envioBoleta.xml' }) {
    const sender = splitRut(senderRut);
    const company = splitRut(companyRut);
    const authToken = validToken(token);
    const rawXml = String(xml || '');
    if (!rawXml.includes('<EnvioBOLETA')) throw httpError(422, 'El archivo no contiene EnvioBOLETA.');

    const form = new FormData();
    form.set('rutSender', sender.body);
    form.set('dvSender', sender.dv);
    form.set('rutCompany', company.body);
    form.set('dvCompany', company.dv);
    form.set('archivo', new Blob([Buffer.from(rawXml, 'latin1')], { type: 'text/xml' }), filename);

    const response = await this.fetch(`${this.baseUrl}/boleta.electronica.envio`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        cookie: `TOKEN=${authToken}`,
        'user-agent': 'SOLVEA-Fiscal/0.5'
      },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const data = await parseResponse(response);
    const trackId = String(data.trackid ?? data.trackId ?? '').trim();
    if (!/^\d{1,20}$/.test(trackId)) throw httpError(502, 'SII no devolvió Track ID válido.', { data });
    return {
      trackId,
      estado: String(data.estado || ''),
      receivedAt: String(data.fecha_recepcion || ''),
      file: String(data.file || filename),
      issuerRut: String(data.rut_emisor || company.normalized),
      senderRut: String(data.rut_envia || sender.normalized),
      raw: data
    };
  }

  async getSubmissionStatus({ token, companyRut, trackId }) {
    const company = splitRut(companyRut);
    const authToken = validToken(token);
    const track = String(trackId || '').trim();
    if (!/^\d{1,20}$/.test(track)) throw httpError(422, 'Track ID inválido.');
    const companyKey = `${company.body}-${company.dv}`;
    const response = await this.fetch(`${this.baseUrl}/boleta.electronica.envio/${companyKey}-${track}`, {
      method: 'GET',
      headers: { accept: 'application/json', cookie: `TOKEN=${authToken}`, 'user-agent': 'SOLVEA-Fiscal/0.5' },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const data = await parseResponse(response);
    return { trackId: track, raw: data };
  }
}
