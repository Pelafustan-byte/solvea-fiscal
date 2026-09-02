// Sobre EnvioDTE genérico (Factura/NC/ND, cualquier TipoDTE) — protocolo de envío real
// verificado contra el manual oficial OI2003_UPDTE_MDE_1.5 y el schema oficial
// EnvioDTE_v10.xsd (descargado de sii.cl/factura_electronica/factura_mercado/schema_dte.zip).
// Mirror de envio-boleta.js (que sólo admite EnvioBOLETA/TipoDTE 39-41) — deliberadamente
// separado para no tocar el código de boleta, ya en producción.
import { createRequire } from 'node:module';
import { escapeXml } from '../lib/xml.js';
import { normalizeRut } from '../domain/rut.js';
import { siiTimestamp } from './ted.js';
import { XMLDSIG } from './xml-signature.js';

const require = createRequire(import.meta.url);
const { SignedXml } = require('xml-crypto');
const xpath = require('xpath');
const { DOMParser } = require('@xmldom/xmldom');

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function wrapBase64(value, width = 76) {
  const clean = String(value || '').replace(/\s+/g, '');
  return clean.match(new RegExp(`.{1,${width}}`, 'g'))?.join('\n') || '';
}

function keyInfoContent(credentials) {
  return ({ prefix = '' } = {}) => {
    const p = (name) => prefix ? `${prefix}:${name}` : name;
    return `<${p('KeyValue')}><${p('RSAKeyValue')}><${p('Modulus')}>${wrapBase64(credentials.modulusBase64)}</${p('Modulus')}><${p('Exponent')}>${escapeXml(credentials.exponentBase64)}</${p('Exponent')}></${p('RSAKeyValue')}></${p('KeyValue')}><${p('X509Data')}><${p('X509Certificate')}>${wrapBase64(credentials.certificateBase64)}</${p('X509Certificate')}></${p('X509Data')}>`;
  };
}

function stripXmlDeclaration(xml) {
  return String(xml || '').replace(/^\s*<\?xml[^?]*\?>\s*/i, '').trim();
}

function safeId(value) {
  const id = String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80);
  if (!id) throw httpError(422, 'ID de SetDTE inválido.');
  return id;
}

export function splitRut(rut) {
  const normalized = normalizeRut(rut);
  const match = normalized.match(/^(\d+)-([0-9K])$/);
  if (!match) throw httpError(422, `RUT inválido: ${rut || '(vacío)'}.`);
  return { normalized, body: match[1], dv: match[2] };
}

function subTotalsXml(dteList) {
  const counts = new Map();
  for (const dte of dteList) {
    const match = dte.match(/<TipoDTE>(\d+)<\/TipoDTE>/);
    if (!match) throw httpError(422, 'No se pudo determinar TipoDTE de un DTE del set.');
    const tipo = Number(match[1]);
    counts.set(tipo, (counts.get(tipo) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tipo, count]) => `<SubTotDTE><TpoDTE>${tipo}</TpoDTE><NroDTE>${count}</NroDTE></SubTotDTE>`)
    .join('');
}

function caratulaXml({ issuer, sender, receiver, resolutionDate, resolutionNumber, tmst, dteList }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(resolutionDate || ''))) throw httpError(422, 'SII_FCH_RESOL debe usar AAAA-MM-DD.');
  const nroResol = Number(resolutionNumber);
  if (!Number.isInteger(nroResol) || nroResol < 0 || nroResol > 999999) throw httpError(422, 'SII_NRO_RESOL inválido.');
  return `<Caratula version="1.0"><RutEmisor>${issuer}</RutEmisor><RutEnvia>${sender}</RutEnvia><RutReceptor>${receiver}</RutReceptor><FchResol>${resolutionDate}</FchResol><NroResol>${nroResol}</NroResol><TmstFirmaEnv>${tmst}</TmstFirmaEnv>${subTotalsXml(dteList)}</Caratula>`;
}

/**
 * Empaqueta VARIOS DTE (ya firmados individualmente, cualquier TipoDTE) en un solo sobre
 * EnvioDTE/SetDTE. Esta función NO envía nada al SII por sí misma — sólo prepara/firma
 * localmente el sobre, igual que buildUnsignedEnvioBoletaSet hace para Boleta.
 */
export function buildUnsignedEnvioDteSet({
  dteXmlList,
  issuerRut,
  senderRut,
  siiReceiverRut = '60803000-K',
  resolutionDate,
  resolutionNumber,
  setId,
  timestamp = new Date(),
  timeZone = 'America/Santiago'
}) {
  if (!Array.isArray(dteXmlList) || !dteXmlList.length) throw httpError(422, 'dteXmlList debe tener al menos un DTE.');
  const issuer = splitRut(issuerRut).normalized;
  const sender = splitRut(senderRut).normalized;
  const receiver = splitRut(siiReceiverRut).normalized;
  const id = safeId(setId);
  const dtes = dteXmlList.map((xml) => {
    const dte = stripXmlDeclaration(xml);
    if (!/^<DTE\b/i.test(dte)) throw httpError(422, 'El contenido a enviar no es un DTE válido.');
    return dte;
  });
  const tmst = siiTimestamp(timestamp, timeZone);
  const caratula = caratulaXml({ issuer, sender, receiver, resolutionDate, resolutionNumber, tmst, dteList: dtes });
  return `<?xml version="1.0" encoding="ISO-8859-1"?>\n<EnvioDTE xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="1.0" xsi:schemaLocation="http://www.sii.cl/SiiDte EnvioDTE.xsd"><SetDTE ID="${id}">${caratula}${dtes.join('')}</SetDTE></EnvioDTE>`;
}

export function buildUnsignedEnvioDte(args) {
  return buildUnsignedEnvioDteSet({ ...args, dteXmlList: [args.dteXml] });
}

export function verifyEnvioDteSignature(xml, certificatePem, setId) {
  try {
    const doc = new DOMParser().parseFromString(String(xml), 'text/xml');
    const signatureNode = xpath.select(`//*[local-name(.)='Signature' and namespace-uri(.)='${XMLDSIG.namespace}']`, doc).at(-1);
    if (!signatureNode) return { valid: false, reason: 'signature_not_found' };
    const verifier = new SignedXml({ publicCert: certificatePem, getCertFromKeyInfo: () => null });
    verifier.loadSignature(signatureNode);
    if (!verifier.checkSignature(String(xml))) return { valid: false, reason: 'cryptographic_verification_failed' };
    const refs = verifier.getReferences();
    if (refs.length !== 1 || refs[0].uri !== `#${setId}`) return { valid: false, reason: 'set_reference_mismatch' };
    return { valid: true, reason: '' };
  } catch (error) {
    return { valid: false, reason: error.message || 'verification_exception' };
  }
}

export function signEnvioDte({ xml, credentials, setId }) {
  if (!credentials?.privateKeyPem || !credentials?.certificatePem) throw httpError(503, 'Faltan credenciales para firmar EnvioDTE.');
  const id = safeId(setId);
  const signer = new SignedXml({
    privateKey: credentials.privateKeyPem,
    publicCert: credentials.certificatePem,
    canonicalizationAlgorithm: XMLDSIG.canonicalization,
    signatureAlgorithm: XMLDSIG.signature,
    getKeyInfoContent: keyInfoContent(credentials)
  });
  signer.addReference({
    xpath: `//*[local-name(.)='SetDTE' and @ID='${id}']`,
    transforms: [XMLDSIG.canonicalization],
    digestAlgorithm: XMLDSIG.digest
  });
  signer.computeSignature(String(xml), {
    location: { reference: "/*[local-name(.)='EnvioDTE']", action: 'append' }
  });
  const signedXml = signer.getSignedXml();
  const verification = verifyEnvioDteSignature(signedXml, credentials.certificatePem, id);
  if (!verification.valid) throw httpError(500, `La firma del sobre EnvioDTE no superó verificación: ${verification.reason}.`);
  return { xml: signedXml, setId: id, verified: true };
}
