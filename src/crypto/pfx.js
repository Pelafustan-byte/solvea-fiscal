import forgeModule from 'node-forge';
import { createPrivateKey, createSign, createVerify, X509Certificate } from 'node:crypto';

const forge = forgeModule?.default || forgeModule;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function decodeBase64Strict(value) {
  const clean = String(value || '').replace(/\s+/g, '');
  if (!clean || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) {
    throw httpError(422, 'Certificado PFX inválido: Base64 no válido.');
  }
  const bytes = Buffer.from(clean, 'base64');
  if (!bytes.length) throw httpError(422, 'Certificado PFX vacío.');
  if (bytes.length > 4 * 1024 * 1024) throw httpError(413, 'Certificado PFX demasiado grande.');
  return bytes;
}

function allBags(pkcs12, bagType) {
  const result = pkcs12.getBags({ bagType });
  return result?.[bagType] || [];
}

function keysMatch(privateKeyPem, certificatePem) {
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    const certificate = new X509Certificate(certificatePem);
    const probe = Buffer.from('SOLVEA-FISCAL-PFX-PAIR-CHECK', 'ascii');
    const signer = createSign('RSA-SHA256');
    signer.update(probe);
    signer.end();
    const signature = signer.sign(privateKey);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(probe);
    verifier.end();
    return verifier.verify(certificate.publicKey, signature);
  } catch {
    return false;
  }
}

function base64UrlToBase64(value) {
  const source = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  return source + '='.repeat((4 - (source.length % 4)) % 4);
}

function wrapBase64(value, width = 76) {
  return String(value || '').match(new RegExp(`.{1,${width}}`, 'g'))?.join('\n') || '';
}

function validateCertificateDates(certificate, now = new Date()) {
  const from = new Date(certificate.validFrom);
  const to = new Date(certificate.validTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw httpError(422, 'No fue posible determinar la vigencia del certificado digital.');
  }
  if (now < from) throw httpError(422, `El certificado digital aún no está vigente. Inicio: ${from.toISOString()}.`);
  if (now > to) throw httpError(422, `El certificado digital está vencido desde ${to.toISOString()}.`);
  return { validFrom: from.toISOString(), validTo: to.toISOString() };
}

export function extractPfxCredentials({ pfxBase64, password = '', now = new Date(), requireCurrent = true }) {
  const bytes = decodeBase64Strict(pfxBase64);
  let pkcs12;
  try {
    const binary = bytes.toString('binary');
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(binary, 'raw'));
    pkcs12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, String(password || ''));
  } catch (error) {
    throw httpError(422, `No fue posible abrir el PFX. Revise archivo y contraseña: ${error.message || 'error PKCS#12'}.`);
  }

  const privateBags = [
    ...allBags(pkcs12, forge.pki.oids.pkcs8ShroudedKeyBag),
    ...allBags(pkcs12, forge.pki.oids.keyBag)
  ].filter((bag) => bag?.key);
  const certificateBags = allBags(pkcs12, forge.pki.oids.certBag).filter((bag) => bag?.cert);

  if (!privateBags.length) throw httpError(422, 'El PFX no contiene una llave privada utilizable.');
  if (!certificateBags.length) throw httpError(422, 'El PFX no contiene certificado X.509.');

  let selected = null;
  for (const keyBag of privateBags) {
    const privateKeyPem = forge.pki.privateKeyToPem(keyBag.key);
    for (const certBag of certificateBags) {
      const certificatePem = forge.pki.certificateToPem(certBag.cert);
      if (keysMatch(privateKeyPem, certificatePem)) {
        selected = { privateKeyPem, certificatePem };
        break;
      }
    }
    if (selected) break;
  }
  if (!selected) throw httpError(422, 'El PFX no contiene un certificado que corresponda a su llave privada.');

  const certificate = new X509Certificate(selected.certificatePem);
  const validity = requireCurrent ? validateCertificateDates(certificate, now) : {
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString()
  };
  const jwk = certificate.publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) throw httpError(422, 'El certificado digital debe utilizar una llave RSA.');

  const certificateBase64 = certificate.raw.toString('base64');
  return Object.freeze({
    privateKeyPem: selected.privateKeyPem,
    certificatePem: selected.certificatePem,
    certificateBase64,
    certificateBase64Wrapped: wrapBase64(certificateBase64),
    modulusBase64: base64UrlToBase64(jwk.n),
    exponentBase64: base64UrlToBase64(jwk.e),
    serialNumber: certificate.serialNumber,
    subject: certificate.subject,
    issuer: certificate.issuer,
    fingerprint256: certificate.fingerprint256,
    ...validity
  });
}
