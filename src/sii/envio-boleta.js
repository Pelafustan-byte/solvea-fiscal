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

export function buildUnsignedEnvioBoleta({
  dteXml,
  documentType,
  issuerRut,
  senderRut,
  siiReceiverRut = '60803000-K',
  resolutionDate,
  resolutionNumber,
  setId,
  timestamp = new Date(),
  timeZone = 'America/Santiago'
}) {
  const issuer = splitRut(issuerRut).normalized;
  const sender = splitRut(senderRut).normalized;
  const receiver = splitRut(siiReceiverRut).normalized;
  if (![39, 41].includes(Number(documentType))) throw httpError(422, 'EnvioBOLETA sólo admite TipoDTE 39 o 41 en esta fase.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(resolutionDate || ''))) throw httpError(422, 'SII_FCH_RESOL debe usar AAAA-MM-DD.');
  const nroResol = Number(resolutionNumber);
  if (!Number.isInteger(nroResol) || nroResol < 0 || nroResol > 999999) throw httpError(422, 'SII_NRO_RESOL inválido.');
  const id = safeId(setId);
  const dte = stripXmlDeclaration(dteXml);
  if (!/^<DTE\b/i.test(dte)) throw httpError(422, 'El contenido a enviar no es un DTE válido.');
  const tmst = siiTimestamp(timestamp, timeZone);
  return `<?xml version="1.0" encoding="ISO-8859-1"?>\n<EnvioBOLETA xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="1.0" xsi:schemaLocation="http://www.sii.cl/SiiDte EnvioBOLETA_v11.xsd"><SetDTE ID="${id}"><Caratula version="1.0"><RutEmisor>${issuer}</RutEmisor><RutEnvia>${sender}</RutEnvia><RutReceptor>${receiver}</RutReceptor><FchResol>${resolutionDate}</FchResol><NroResol>${nroResol}</NroResol><TmstFirmaEnv>${tmst}</TmstFirmaEnv><SubTotDTE><TpoDTE>${Number(documentType)}</TpoDTE><NroDTE>1</NroDTE></SubTotDTE></Caratula>${dte}</SetDTE></EnvioBOLETA>`;
}

export function verifyEnvioBoletaSignature(xml, certificatePem, setId) {
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

export function signEnvioBoleta({ xml, credentials, setId }) {
  if (!credentials?.privateKeyPem || !credentials?.certificatePem) throw httpError(503, 'Faltan credenciales para firmar EnvioBOLETA.');
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
    location: { reference: "/*[local-name(.)='EnvioBOLETA']", action: 'append' }
  });
  const signedXml = signer.getSignedXml();
  const verification = verifyEnvioBoletaSignature(signedXml, credentials.certificatePem, id);
  if (!verification.valid) throw httpError(500, `La firma del sobre EnvioBOLETA no superó verificación: ${verification.reason}.`);
  return { xml: signedXml, setId: id, verified: true };
}
