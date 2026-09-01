// Diagnóstico NO destructivo de autenticación contra pangal.sii.cl/boleta.electronica.envio.
// Nunca envía archivo/XML/DTE — sólo los 4 campos de texto (rutSender/dvSender/rutCompany/
// dvCompany) que la especificación exige aparte del archivo, precisamente para que el SII no
// pueda registrar ningún documento con esta petición.
//
// Fuente: mismo OpenAPI 3.0.1 ya verificado (https://www4c.sii.cl/bolcoreinternetui/api/openapi.yaml).
// servers: apicert.sii.cl/recursos/v1 (certificación general) — pangal.sii.cl/recursos/v1
// documentado como "(Temporal) exclusivo envio (POST /boleta.electronica.envio)". El TOKEN se
// envía en `Cookie: TOKEN=<token>` (security scheme TOKEN, type apiKey, in: header) — el mismo
// mecanismo para ambos hosts según el spec; no existe en el spec un "token específico de pangal".

import { createHash } from 'node:crypto';
import https from 'node:https';
import { splitRut } from './envio-boleta.js';

export function tokenFingerprint(token) {
  return createHash('sha256').update(String(token || '')).digest('hex').slice(0, 12);
}

function tokenMeta(token) {
  return { tokenPresent: Boolean(token), tokenLength: String(token || '').length, tokenFingerprint: tokenFingerprint(token) };
}

/**
 * Probe con fetch nativo, redirect:'manual' (nunca sigue una redirección automáticamente).
 * Multipart deliberadamente incompleto: rutSender/dvSender/rutCompany/dvCompany, SIN 'archivo'.
 */
export async function probePangalAuthFetch({ pangalBaseUrl, token, senderRut, companyRut, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  const sender = splitRut(senderRut);
  const company = splitRut(companyRut);
  const form = new FormData();
  form.set('rutSender', sender.body);
  form.set('dvSender', sender.dv);
  form.set('rutCompany', company.body);
  form.set('dvCompany', company.dv);

  const url = `${String(pangalBaseUrl).replace(/\/$/, '')}/boleta.electronica.envio`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { accept: 'application/json', cookie: `TOKEN=${token}`, 'user-agent': 'SOLVEA-Fiscal/0.7-probe' },
      body: form,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return { client: 'fetch', httpStatus: null, reason: `network_error: ${error.message}`, ...tokenMeta(token) };
  }

  const bodyText = await response.text().catch(() => '');
  return {
    client: 'fetch',
    httpStatus: response.status,
    redirected: Boolean(response.redirected) || (response.status >= 300 && response.status < 400),
    responseUrl: response.url || '',
    location: response.headers.get('location') || '',
    contentType: response.headers.get('content-type') || '',
    bodyPreview: bodyText.slice(0, 1000),
    ...tokenMeta(token)
  };
}

function multipartFieldPart(boundary, name, value) {
  return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

/**
 * Mismo probe (mismos 4 campos, sin archivo) pero con node:https nativo, para descartar que el
 * 401 sea un problema de la implementación de fetch/undici en vez de una respuesta real del SII.
 * https.request nunca sigue redirecciones automáticamente por diseño.
 *
 * Acepta opcionalmente `cert`/`key` (PEM) para probar TLS mutuo (mTLS): algunos webservices DTE
 * legacy del SII exigen que el cliente presente el certificado digital en el handshake TLS,
 * además del token por cookie — algo que un spec OpenAPI típicamente no documenta porque es un
 * requisito de transporte, no de la capa HTTP.
 */
export function probePangalAuthHttps({ pangalBaseUrl, token, senderRut, companyRut, timeoutMs = 15_000, requestImpl = https.request, cert, key }) {
  const sender = splitRut(senderRut);
  const company = splitRut(companyRut);
  const boundary = `----solveaFiscalProbe${Date.now()}`;
  const body = Buffer.from(
    multipartFieldPart(boundary, 'rutSender', sender.body) +
    multipartFieldPart(boundary, 'dvSender', sender.dv) +
    multipartFieldPart(boundary, 'rutCompany', company.body) +
    multipartFieldPart(boundary, 'dvCompany', company.dv) +
    `--${boundary}--\r\n`,
    'utf8'
  );
  const url = new URL(`${String(pangalBaseUrl).replace(/\/$/, '')}/boleta.electronica.envio`);

  return new Promise((resolve) => {
    const req = requestImpl({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        accept: 'application/json',
        cookie: `TOKEN=${token}`,
        'user-agent': 'SOLVEA-Fiscal/0.7-probe',
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': body.length
      },
      timeout: timeoutMs,
      ...(cert && key ? { cert, key } : {})
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          client: 'https.request',
          mtls: Boolean(cert && key),
          httpStatus: res.statusCode,
          redirected: Boolean(res.statusCode >= 300 && res.statusCode < 400),
          location: res.headers.location || '',
          contentType: res.headers['content-type'] || '',
          bodyPreview: String(data).slice(0, 1000),
          ...tokenMeta(token)
        });
      });
    });
    req.on('error', (error) => resolve({ client: 'https.request', mtls: Boolean(cert && key), httpStatus: null, reason: `network_error: ${error.message}`, ...tokenMeta(token) }));
    req.on('timeout', () => { req.destroy(); resolve({ client: 'https.request', mtls: Boolean(cert && key), httpStatus: null, reason: 'timeout', ...tokenMeta(token) }); });
    req.write(body);
    req.end();
  });
}

/**
 * Orquesta el diagnóstico completo: fetch primero; si detecta redirección, se detiene ahí (no
 * sigue, no compara con https.request todavía). Si no hay redirección, corre también el probe
 * con https.request para poder comparar. Nunca incluye archivo/XML/DTE/CAF.
 */
export async function diagnosePangalAuth({ pangalBaseUrl, token, senderRut, companyRut, fetchImpl, requestImpl, timeoutMs, cert, key }) {
  const fetchProbe = await probePangalAuthFetch({ pangalBaseUrl, token, senderRut, companyRut, fetchImpl, timeoutMs });
  if (fetchProbe.redirected) {
    return { fetchProbe, httpsProbe: null, httpsMtlsProbe: null, stoppedOnRedirect: true };
  }
  const httpsProbe = await probePangalAuthHttps({ pangalBaseUrl, token, senderRut, companyRut, timeoutMs, requestImpl });
  // Si tenemos certificado/clave del PFX, probamos también CON TLS mutuo, para aislar si pangal
  // exige el certificado en el handshake además del token por cookie.
  const httpsMtlsProbe = (cert && key)
    ? await probePangalAuthHttps({ pangalBaseUrl, token, senderRut, companyRut, timeoutMs, requestImpl, cert, key })
    : null;
  return { fetchProbe, httpsProbe, httpsMtlsProbe, stoppedOnRedirect: false };
}
