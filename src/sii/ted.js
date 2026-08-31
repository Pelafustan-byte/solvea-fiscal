import { createSign, createVerify } from 'node:crypto';
import { escapeXml } from '../lib/xml.js';

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function latin1(value, field) {
  const text = String(value ?? '');
  for (const char of text) {
    if (char.codePointAt(0) > 255) throw httpError(422, `${field} contiene caracteres fuera de ISO-8859-1.`);
  }
  return text;
}

function truncate(value, max) {
  return Array.from(String(value ?? '')).slice(0, max).join('');
}

function partsInTimeZone(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw httpError(422, 'Fecha inválida para generar TED.');
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  return parts;
}

export function siiDate(value, timeZone = 'America/Santiago') {
  const parts = partsInTimeZone(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function siiTimestamp(value = new Date(), timeZone = 'America/Santiago') {
  const parts = partsInTimeZone(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function normalizeTedDataForSignature(ddXml) {
  return String(ddXml)
    .replace(/\r?\n/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}

function wrapBase64(value) {
  return String(value).match(/.{1,76}/g)?.join('\n') || '';
}

export function buildTed({ document, issuer, caf, folio, timestamp, timeZone = 'America/Santiago' }) {
  const receiverRut = document.recipient.rut || '66666666-6';
  const receiverName = latin1(truncate(document.recipient.legalName || 'Consumidor Final', 40), 'Razón social receptor');
  const firstItem = latin1(truncate(document.items[0]?.name || 'Venta', 40), 'Descripción primer ítem');
  const emissionDate = siiDate(document.sale.completedAt || timestamp, timeZone);
  const tedTimestamp = siiTimestamp(timestamp, timeZone);

  const ddXml = `<DD><RE>${escapeXml(issuer.rut)}</RE><TD>${document.documentCode}</TD><F>${folio}</F><FE>${emissionDate}</FE><RR>${escapeXml(receiverRut)}</RR><RSR>${escapeXml(receiverName)}</RSR><MNT>${document.sale.total}</MNT><IT1>${escapeXml(firstItem)}</IT1>${caf.cafXml}<TSTED>${tedTimestamp}</TSTED></DD>`;
  const normalized = normalizeTedDataForSignature(ddXml);

  const signer = createSign('RSA-SHA1');
  signer.update(Buffer.from(normalized, 'latin1'));
  signer.end();
  const signature = signer.sign(caf.privateKeyPem).toString('base64');
  const signatureWrapped = wrapBase64(signature);
  const tedXml = `<TED version="1.0">${ddXml}<FRMT algoritmo="SHA1withRSA">${signatureWrapped}</FRMT></TED>`;

  if (!verifyTedSignature({ ddXml, signatureBase64: signature, publicKeyPem: caf.publicKeyPem })) {
    throw httpError(500, 'No fue posible verificar internamente la firma del TED generado.');
  }

  return {
    tedXml,
    ddXml,
    normalizedDd: normalized,
    signatureBase64: signature,
    timestamp: tedTimestamp,
    emissionDate
  };
}

export function verifyTedSignature({ ddXml, signatureBase64, publicKeyPem }) {
  try {
    const verifier = createVerify('RSA-SHA1');
    verifier.update(Buffer.from(normalizeTedDataForSignature(ddXml), 'latin1'));
    verifier.end();
    return verifier.verify(publicKeyPem, Buffer.from(String(signatureBase64).replace(/\s+/g, ''), 'base64'));
  } catch {
    return false;
  }
}
