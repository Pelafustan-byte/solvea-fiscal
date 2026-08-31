import { createRequire } from 'node:module';
import { escapeXml } from '../lib/xml.js';

const require = createRequire(import.meta.url);
const { SignedXml } = require('xml-crypto');
const xpath = require('xpath');
const { DOMParser } = require('@xmldom/xmldom');

export const XMLDSIG = Object.freeze({
  namespace: 'http://www.w3.org/2000/09/xmldsig#',
  canonicalization: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  digest: 'http://www.w3.org/2000/09/xmldsig#sha1'
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

function prefixTag(prefix, name) {
  return prefix ? `${prefix}:${name}` : name;
}

function keyInfoContent(credentials) {
  return ({ prefix = '' } = {}) => {
    const keyValue = prefixTag(prefix, 'KeyValue');
    const rsaKeyValue = prefixTag(prefix, 'RSAKeyValue');
    const modulus = prefixTag(prefix, 'Modulus');
    const exponent = prefixTag(prefix, 'Exponent');
    const x509Data = prefixTag(prefix, 'X509Data');
    const x509Certificate = prefixTag(prefix, 'X509Certificate');
    return `<${keyValue}><${rsaKeyValue}><${modulus}>${wrapBase64(credentials.modulusBase64)}</${modulus}><${exponent}>${escapeXml(credentials.exponentBase64)}</${exponent}></${rsaKeyValue}></${keyValue}><${x509Data}><${x509Certificate}>${wrapBase64(credentials.certificateBase64)}</${x509Certificate}></${x509Data}>`;
  };
}

function extractDocumentId(xml) {
  const match = String(xml).match(/<Documento\b[^>]*\bID=["']([^"']+)["']/i);
  if (!match) throw httpError(422, 'El DTE no contiene Documento@ID para XMLDSIG.');
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(match[1])) throw httpError(422, 'Documento@ID contiene caracteres no permitidos.');
  return match[1];
}

function wrapUnsignedKeyInfoFields(xml) {
  return String(xml)
    .replace(/<Modulus>([\s\S]*?)<\/Modulus>/, (_full, value) => `<Modulus>${wrapBase64(value)}</Modulus>`)
    .replace(/<X509Certificate>([\s\S]*?)<\/X509Certificate>/, (_full, value) => `<X509Certificate>${wrapBase64(value)}</X509Certificate>`);
}

export function verifyDteSignature(xml, certificatePem, expectedDocumentId = '') {
  try {
    const doc = new DOMParser().parseFromString(String(xml), 'text/xml');
    const parserErrors = xpath.select("//*[local-name(.)='parsererror']", doc);
    if (parserErrors.length) return { valid: false, signedReferences: [], reason: 'xml_parse_error' };
    const signatureNode = xpath.select(`//*[local-name(.)='Signature' and namespace-uri(.)='${XMLDSIG.namespace}']`, doc)[0];
    if (!signatureNode) return { valid: false, signedReferences: [], reason: 'signature_not_found' };

    const verifier = new SignedXml({
      publicCert: certificatePem,
      getCertFromKeyInfo: () => null
    });
    verifier.loadSignature(signatureNode);
    const valid = verifier.checkSignature(String(xml));
    if (!valid) return { valid: false, signedReferences: [], reason: 'cryptographic_verification_failed' };

    const signedReferences = verifier.getSignedReferences().map((value) => String(value));
    if (signedReferences.length !== 1) return { valid: false, signedReferences, reason: 'unexpected_reference_count' };
    if (expectedDocumentId && !signedReferences[0].includes(`ID="${expectedDocumentId}"`) && !signedReferences[0].includes(`ID='${expectedDocumentId}'`)) {
      return { valid: false, signedReferences, reason: 'signed_reference_id_mismatch' };
    }
    return { valid: true, signedReferences, reason: '' };
  } catch (error) {
    return { valid: false, signedReferences: [], reason: error.message || 'verification_exception' };
  }
}

export function signDteXml({ xml, credentials }) {
  if (!credentials?.privateKeyPem || !credentials?.certificatePem) {
    throw httpError(503, 'Faltan credenciales PEM para firmar el DTE.');
  }
  const documentId = extractDocumentId(xml);
  const signer = new SignedXml({
    privateKey: credentials.privateKeyPem,
    publicCert: credentials.certificatePem,
    canonicalizationAlgorithm: XMLDSIG.canonicalization,
    signatureAlgorithm: XMLDSIG.signature,
    getKeyInfoContent: keyInfoContent(credentials)
  });
  signer.addReference({
    xpath: `//*[local-name(.)='Documento' and @ID='${documentId}']`,
    transforms: [XMLDSIG.canonicalization],
    digestAlgorithm: XMLDSIG.digest
  });
  signer.computeSignature(String(xml), {
    location: { reference: "//*[local-name(.)='Documento']", action: 'after' }
  });

  const signedXml = wrapUnsignedKeyInfoFields(signer.getSignedXml());
  const verification = verifyDteSignature(signedXml, credentials.certificatePem, documentId);
  if (!verification.valid) {
    throw httpError(500, `La firma XMLDSIG generada no superó la verificación interna: ${verification.reason}.`);
  }

  const signatureMatch = signedXml.match(/<SignatureValue>([\s\S]*?)<\/SignatureValue>/);
  const digestMatch = signedXml.match(/<DigestValue>([\s\S]*?)<\/DigestValue>/);
  return {
    xml: signedXml,
    documentId,
    verified: true,
    signatureValue: signatureMatch?.[1]?.replace(/\s+/g, '') || '',
    digestValue: digestMatch?.[1]?.replace(/\s+/g, '') || '',
    algorithms: { ...XMLDSIG }
  };
}
