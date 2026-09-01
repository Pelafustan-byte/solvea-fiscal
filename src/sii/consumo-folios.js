// Reporte de Consumo de Folios (RCOF) — formato oficial SII "ConsumoFolios".
//
// Fuentes verificadas (no se inventaron tags):
//  - Esquema: https://www.sii.cl/factura_electronica/ConsumoFolio_v10.xsd (obtenido y leído tal cual)
//  - Descripción de campos: https://www.sii.cl/factura_electronica/consumo_folios.pdf
//    ("FORMATO ARCHIVO ELECTRÓNICO REPORTE CONSUMO DE FOLIOS", 5 Feb 2009, v1.0)
//
// Nota importante sobre vigencia: la Resolución Ex. SII N°53/2022 eliminó la obligación de
// enviar este reporte como OBLIGACIÓN OPERACIONAL PERIÓDICA (diaria) una vez que el
// contribuyente ya está habilitado como emisor — el Registro de Ventas se alimenta desde
// ese momento automáticamente con las boletas recibidas por el SII. El correo de
// certificación 2026 recibido por el usuario, sin embargo, exige expresamente este RCOF
// como parte del PROCESO DE CERTIFICACIÓN (paso 3, distinto de la obligación operacional ya
// eliminada). Este módulo implementa el formato de certificación; no implica reactivar
// ningún envío periódico de producción.
//
// Estructura verificada contra el XSD real:
//   <ConsumoFolios version="1.0">
//     <DocumentoConsumoFolios ID="...">
//       <Caratula version="1.0">
//         <RutEmisor/> <RutEnvia/> <FchResol/> <NroResol/> <FchInicio/> <FchFinal/>
//         <Correlativo/> (opcional) <SecEnvio/> <TmstFirmaEnv/>
//       </Caratula>
//       <Resumen> (1 a 3 ocurrencias — una por TipoDocumento: 39, 41 o 61)
//         <TipoDocumento/>
//         <MntNeto/> <MntIva/> <TasaIVA/> <MntExento/> (todos opcionales)
//         <MntTotal/> (obligatorio)
//         <FoliosEmitidos/> <FoliosAnulados/> <FoliosUtilizados/>
//         <RangoUtilizados><Inicial/><Final/></RangoUtilizados> (0..N)
//         <RangoAnulados><Inicial/><Final/></RangoAnulados> (0..N, Final opcional para folio individual)
//       </Resumen>
//     </DocumentoConsumoFolios>
//     <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">...</Signature>
//   </ConsumoFolios>

import { createRequire } from 'node:module';
import { escapeXml, tag } from '../lib/xml.js';
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

function safeId(value) {
  const id = String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80);
  if (!id) throw httpError(422, 'ID de DocumentoConsumoFolios inválido.');
  return id;
}

function requireRut(value, field) {
  const normalized = normalizeRut(value);
  if (!normalized) throw httpError(422, `${field} inválido.`);
  return normalized;
}

function requireDate(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw httpError(422, `${field} debe usar AAAA-MM-DD.`);
  return value;
}

function nonNegativeInt(value, field, maxDigits) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw httpError(422, `${field} debe ser un entero no negativo.`);
  if (String(n).length > maxDigits) throw httpError(422, `${field} excede ${maxDigits} dígitos.`);
  return n;
}

const TIPO_CONSUMO_CODES = new Set([39, 41, 61]);

function rangesXml(name, ranges) {
  return (ranges || []).map((range, index) => {
    const inicial = nonNegativeInt(range.inicial, `${name}[${index}].inicial`, 10);
    const hasFinal = range.final !== undefined && range.final !== null;
    const final = hasFinal ? nonNegativeInt(range.final, `${name}[${index}].final`, 10) : null;
    if (hasFinal && final < inicial) throw httpError(422, `${name}[${index}]: final no puede ser menor que inicial.`);
    return `<${name}>${tag('Inicial', inicial)}${hasFinal ? tag('Final', final) : ''}</${name}>`;
  }).join('');
}

function resumenXml(resumen, index) {
  if (!TIPO_CONSUMO_CODES.has(Number(resumen.documentType))) {
    throw httpError(422, `resumenes[${index}].documentType debe ser 39, 41 o 61.`);
  }
  const foliosEmitidos = nonNegativeInt(resumen.foliosEmitidos, `resumenes[${index}].foliosEmitidos`, 6);
  const foliosAnulados = nonNegativeInt(resumen.foliosAnulados, `resumenes[${index}].foliosAnulados`, 6);
  const foliosUtilizados = nonNegativeInt(resumen.foliosUtilizados, `resumenes[${index}].foliosUtilizados`, 6);
  if (foliosEmitidos + foliosAnulados !== foliosUtilizados) {
    throw httpError(422, `resumenes[${index}]: FoliosEmitidos + FoliosAnulados debe ser igual a FoliosUtilizados.`);
  }
  const mntTotal = nonNegativeInt(resumen.mntTotal, `resumenes[${index}].mntTotal`, 18);

  const parts = [
    tag('TipoDocumento', Number(resumen.documentType)),
    resumen.mntNeto !== undefined ? tag('MntNeto', nonNegativeInt(resumen.mntNeto, `resumenes[${index}].mntNeto`, 18)) : '',
    resumen.mntIva !== undefined ? tag('MntIva', nonNegativeInt(resumen.mntIva, `resumenes[${index}].mntIva`, 18)) : '',
    resumen.tasaIva !== undefined ? tag('TasaIVA', resumen.tasaIva) : '',
    resumen.mntExento !== undefined ? tag('MntExento', nonNegativeInt(resumen.mntExento, `resumenes[${index}].mntExento`, 18)) : '',
    tag('MntTotal', mntTotal),
    tag('FoliosEmitidos', foliosEmitidos),
    tag('FoliosAnulados', foliosAnulados),
    tag('FoliosUtilizados', foliosUtilizados),
    rangesXml('RangoUtilizados', resumen.rangoUtilizados),
    rangesXml('RangoAnulados', resumen.rangoAnulados)
  ];
  return `<Resumen>${parts.join('')}</Resumen>`;
}

export function buildUnsignedConsumoFolios({
  documentoId,
  issuerRut,
  senderRut,
  resolutionDate,
  resolutionNumber,
  periodStart,
  periodEnd,
  secEnvio = 1,
  correlativo,
  resumenes,
  timestamp = new Date(),
  timeZone = 'America/Santiago'
}) {
  const issuer = requireRut(issuerRut, 'RutEmisor');
  const sender = requireRut(senderRut, 'RutEnvia');
  requireDate(resolutionDate, 'FchResol');
  const nroResol = Number(resolutionNumber);
  if (!Number.isInteger(nroResol) || nroResol < 0) throw httpError(422, 'NroResol inválido.');
  requireDate(periodStart, 'FchInicio');
  requireDate(periodEnd, 'FchFinal');
  if (!Array.isArray(resumenes) || !resumenes.length) throw httpError(422, 'Se requiere al menos un Resumen.');
  if (resumenes.length > 3) throw httpError(422, 'ConsumoFolios admite máximo 3 Resumen (uno por TipoDocumento).');

  const id = safeId(documentoId);
  const tmst = siiTimestamp(timestamp, timeZone);
  const caratula = `<Caratula version="1.0">${tag('RutEmisor', issuer)}${tag('RutEnvia', sender)}${tag('FchResol', resolutionDate)}${tag('NroResol', nroResol)}${tag('FchInicio', periodStart)}${tag('FchFinal', periodEnd)}${correlativo !== undefined ? tag('Correlativo', correlativo) : ''}${tag('SecEnvio', secEnvio)}${tag('TmstFirmaEnv', tmst)}</Caratula>`;
  const resumenesXml = resumenes.map(resumenXml).join('');

  return `<?xml version="1.0" encoding="ISO-8859-1"?>\n<ConsumoFolios xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="1.0" xsi:schemaLocation="http://www.sii.cl/SiiDte ConsumoFolio_v10.xsd"><DocumentoConsumoFolios ID="${id}">${caratula}${resumenesXml}</DocumentoConsumoFolios></ConsumoFolios>`;
}

export function verifyConsumoFoliosSignature(xml, certificatePem, documentoId) {
  try {
    const doc = new DOMParser().parseFromString(String(xml), 'text/xml');
    const signatureNode = xpath.select(`//*[local-name(.)='Signature' and namespace-uri(.)='${XMLDSIG.namespace}']`, doc).at(-1);
    if (!signatureNode) return { valid: false, reason: 'signature_not_found' };
    const verifier = new SignedXml({ publicCert: certificatePem, getCertFromKeyInfo: () => null });
    verifier.loadSignature(signatureNode);
    if (!verifier.checkSignature(String(xml))) return { valid: false, reason: 'cryptographic_verification_failed' };
    const refs = verifier.getReferences();
    if (refs.length !== 1 || refs[0].uri !== `#${documentoId}`) return { valid: false, reason: 'document_reference_mismatch' };
    return { valid: true, reason: '' };
  } catch (error) {
    return { valid: false, reason: error.message || 'verification_exception' };
  }
}

export function signConsumoFolios({ xml, credentials, documentoId }) {
  if (!credentials?.privateKeyPem || !credentials?.certificatePem) throw httpError(503, 'Faltan credenciales para firmar ConsumoFolios.');
  const id = safeId(documentoId);
  const signer = new SignedXml({
    privateKey: credentials.privateKeyPem,
    publicCert: credentials.certificatePem,
    canonicalizationAlgorithm: XMLDSIG.canonicalization,
    signatureAlgorithm: XMLDSIG.signature,
    getKeyInfoContent: keyInfoContent(credentials)
  });
  signer.addReference({
    xpath: `//*[local-name(.)='DocumentoConsumoFolios' and @ID='${id}']`,
    transforms: [XMLDSIG.canonicalization],
    digestAlgorithm: XMLDSIG.digest
  });
  signer.computeSignature(String(xml), {
    location: { reference: "/*[local-name(.)='ConsumoFolios']", action: 'append' }
  });
  const signedXml = signer.getSignedXml();
  const verification = verifyConsumoFoliosSignature(signedXml, credentials.certificatePem, id);
  if (!verification.valid) throw httpError(500, `La firma de ConsumoFolios no superó verificación: ${verification.reason}.`);
  return { xml: signedXml, documentoId: id, verified: true };
}

/**
 * Convierte una lista de folios (enteros) en rangos consecutivos, tal como exige el
 * esquema ConsumoFolios (RangoUtilizados/RangoAnulados). Ej: [1,2,3,5,6] -> [{1,3},{5,6}].
 */
export function foliosToRanges(folios) {
  const sorted = [...new Set(folios.map(Number))].sort((a, b) => a - b);
  const ranges = [];
  for (const folio of sorted) {
    const last = ranges.at(-1);
    if (last && folio === last.final + 1) {
      last.final = folio;
    } else {
      ranges.push({ inicial: folio, final: folio });
    }
  }
  return ranges;
}
