import { createRequire } from 'node:module';
import { escapeXml } from '../lib/xml.js';

const require = createRequire(import.meta.url);
const { SignedXml } = require('xml-crypto');
const xpath = require('xpath');
const { DOMParser } = require('@xmldom/xmldom');

export const SEED_XMLDSIG = Object.freeze({
  namespace: 'http://www.w3.org/2000/09/xmldsig#',
  canonicalization: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  digest: 'http://www.w3.org/2000/09/xmldsig#sha1',
  enveloped: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
});

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

function normalizeSeed(seed) {
  const value = String(seed || '').trim();
  if (!/^\d{1,32}$/.test(value)) throw httpError(422, 'Semilla SII inválida.');
  return value;
}

export function buildSeedXml(seed) {
  return `<?xml version="1.0"?><getToken><item><Semilla>${normalizeSeed(seed)}</Semilla></item></getToken>`;
}

export function verifySignedSeed(xml, certificatePem) {
  try {
    const doc = new DOMParser().parseFromString(String(xml), 'text/xml');
    const signatureNode = xpath.select(`//*[local-name(.)='Signature' and namespace-uri(.)='${SEED_XMLDSIG.namespace}']`, doc)[0];
    if (!signatureNode) return { valid: false, reason: 'signature_not_found' };
    const verifier = new SignedXml({ publicCert: certificatePem, getCertFromKeyInfo: () => null });
    verifier.loadSignature(signatureNode);
    if (!verifier.checkSignature(String(xml))) return { valid: false, reason: 'cryptographic_verification_failed' };
    return { valid: true, reason: '' };
  } catch (error) {
    return { valid: false, reason: error.message || 'verification_exception' };
  }
}

export function signSeedXml({ seed, credentials }) {
  if (!credentials?.privateKeyPem || !credentials?.certificatePem) {
    throw httpError(503, 'Faltan credenciales para firmar la semilla SII.');
  }
  const source = buildSeedXml(seed);
  const signer = new SignedXml({
    privateKey: credentials.privateKeyPem,
    publicCert: credentials.certificatePem,
    canonicalizationAlgorithm: SEED_XMLDSIG.canonicalization,
    signatureAlgorithm: SEED_XMLDSIG.signature,
    getKeyInfoContent: keyInfoContent(credentials)
  });
  signer.addReference({
    xpath: "/*[local-name(.)='getToken']",
    transforms: [SEED_XMLDSIG.enveloped],
    digestAlgorithm: SEED_XMLDSIG.digest,
    uri: ''
  });
  signer.computeSignature(source, {
    location: { reference: "/*[local-name(.)='getToken']", action: 'append' }
  });
  const xml = signer.getSignedXml();
  const verification = verifySignedSeed(xml, credentials.certificatePem);
  if (!verification.valid) throw httpError(500, `La firma de semilla no superó la verificación interna: ${verification.reason}.`);
  return { xml, seed: normalizeSeed(seed), verified: true, algorithms: { ...SEED_XMLDSIG } };
}
