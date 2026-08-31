import { createHash, createPrivateKey, createPublicKey, createSign, createVerify } from 'node:crypto';
import { normalizeRut } from '../domain/rut.js';

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readTag(xml, name, required = true) {
  const match = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  if (!match) {
    if (!required) return '';
    throw httpError(422, `CAF inválido: falta <${name}>.`);
  }
  return match[1].trim();
}

function decodeXmlText(value) {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function normalizePem(value, kind) {
  const cleaned = decodeXmlText(value).replace(/^\s*:\s*/, '').trim();
  if (cleaned.includes('-----BEGIN ')) return cleaned.endsWith('\n') ? cleaned : `${cleaned}\n`;

  const base64 = cleaned.replace(/\s+/g, '');
  if (!base64) throw httpError(422, `CAF inválido: falta llave ${kind}.`);
  const label = kind === 'private' ? 'RSA PRIVATE KEY' : 'PUBLIC KEY';
  const lines = base64.match(/.{1,64}/g)?.join('\n') || base64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

function verifyKeyPair(privateKeyPem, publicKeyPem) {
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    const publicKey = createPublicKey(publicKeyPem);
    const probe = Buffer.from('SOLVEA-FISCAL-CAF-KEY-CHECK', 'ascii');
    const signer = createSign('RSA-SHA1');
    signer.update(probe);
    signer.end();
    const signature = signer.sign(privateKey);
    const verifier = createVerify('RSA-SHA1');
    verifier.update(probe);
    verifier.end();
    return verifier.verify(publicKey, signature);
  } catch {
    return false;
  }
}

export function decodeCafBase64(value) {
  if (!value) return '';
  let bytes;
  try {
    bytes = Buffer.from(String(value).replace(/\s+/g, ''), 'base64');
  } catch {
    throw httpError(422, 'CAF inválido: no se pudo decodificar Base64.');
  }
  if (!bytes.length) throw httpError(422, 'CAF inválido: contenido Base64 vacío.');

  const header = bytes.subarray(0, Math.min(bytes.length, 256)).toString('ascii');
  const utf8 = /encoding=["']UTF-8["']/i.test(header);
  return bytes.toString(utf8 ? 'utf8' : 'latin1').replace(/^\uFEFF/, '');
}

export function parseCaf(authorizationXml) {
  const source = String(authorizationXml || '').trim();
  if (!source) throw httpError(422, 'CAF vacío.');
  if (Buffer.byteLength(source, 'latin1') > 2 * 1024 * 1024) throw httpError(413, 'CAF demasiado grande.');

  const cafMatch = source.match(/<CAF\b[^>]*>[\s\S]*?<\/CAF>/i);
  if (!cafMatch) throw httpError(422, 'CAF inválido: no contiene bloque <CAF>.');
  const cafXml = cafMatch[0];
  const da = readTag(cafXml, 'DA');
  const range = readTag(da, 'RNG');
  const privateRaw = readTag(source, 'RSASK');
  const publicRaw = readTag(source, 'RSAPUBK');

  const rut = normalizeRut(readTag(da, 'RE'));
  const documentType = Number(readTag(da, 'TD'));
  const from = Number(readTag(range, 'D'));
  const to = Number(readTag(range, 'H'));
  const authorizedAt = readTag(da, 'FA');
  const privateKeyPem = normalizePem(privateRaw, 'private');
  const publicKeyPem = normalizePem(publicRaw, 'public');

  if (!rut || !Number.isInteger(documentType) || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw httpError(422, 'CAF inválido: emisor, tipo DTE o rango de folios no válido.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(authorizedAt)) throw httpError(422, 'CAF inválido: fecha de autorización no válida.');
  if (!verifyKeyPair(privateKeyPem, publicKeyPem)) {
    throw httpError(422, 'CAF inválido: la llave privada no corresponde a la llave pública entregada por el SII.');
  }

  return Object.freeze({
    id: createHash('sha256').update(Buffer.from(cafXml, 'latin1')).digest('hex'),
    rut,
    documentType,
    from,
    to,
    authorizedAt,
    cafXml,
    privateKeyPem,
    publicKeyPem
  });
}

export function assertCafCompatible(caf, { issuerRut, documentType }) {
  const expectedRut = normalizeRut(issuerRut);
  if (caf.rut !== expectedRut) {
    throw httpError(422, `El CAF pertenece al RUT ${caf.rut}, no al emisor configurado ${expectedRut || '(vacío)'}.`);
  }
  if (Number(caf.documentType) !== Number(documentType)) {
    throw httpError(422, `El CAF autoriza TipoDTE ${caf.documentType}, no ${documentType}.`);
  }
  return caf;
}
