import { computeTaxTotals, FACTURA_CODES } from '../domain/totals.js';
import { tag } from '../lib/xml.js';
import { siiDate, siiTimestamp } from './ted.js';

function detailXml(item, index) {
  return `<Detalle>${tag('NroLinDet', index + 1)}${item.sku ? `<CdgItem>${tag('TpoCodigo', 'INT1')}${tag('VlrCodigo', item.sku)}</CdgItem>` : ''}${item.exempt ? tag('IndExe', 1) : ''}${tag('NmbItem', item.name)}${tag('QtyItem', item.quantity)}${item.unitMeasure ? tag('UnmdItem', item.unitMeasure) : ''}${tag('PrcItem', item.unitPrice)}${tag('MontoItem', item.subtotal)}</Detalle>`;
}

function totalsXml(document) {
  const totals = computeTaxTotals(document);
  if ([41, 34].includes(Number(document.documentCode))) {
    return `<Totales>${tag('MntExe', totals.exempt)}${tag('MntTotal', totals.total)}</Totales>`;
  }
  return `<Totales>${tag('MntNeto', totals.net)}${totals.exempt > 0 ? tag('MntExe', totals.exempt) : ''}${tag('IVA', totals.vat)}${tag('MntTotal', totals.total)}</Totales>`;
}

function referenceXml(reference) {
  if (!reference) return '';
  return `<Referencia>${tag('NroLinRef', 1)}${tag('CodRef', reference.code)}${tag('RazonRef', reference.reason)}</Referencia>`;
}

export function buildUnsignedBoletaDraft({
  document,
  issuer,
  provisionalFolio = 0,
  paymentMethodCode = 5,
  tedXml = '',
  signatureTimestamp = null,
  timeZone = 'America/Santiago'
}) {
  const isFactura = FACTURA_CODES.has(Number(document.documentCode));
  const receiverRut = document.recipient.rut || (isFactura ? '' : '66666666-6');
  const receiverName = document.recipient.legalName || (isFactura ? '' : 'Consumidor Final');
  const documentId = provisionalFolio > 0
    ? `F${provisionalFolio}T${document.documentCode}`
    : `SOLVEA-DRAFT-${document.sale.id}`;

  const receptorTail = isFactura
    ? `${tag('GiroRecep', document.recipient.activity)}${tag('DirRecep', document.recipient.address)}${tag('CmnaRecep', document.recipient.commune)}${tag('CiudadRecep', document.recipient.city)}${document.recipient.email ? tag('CorreoRecep', document.recipient.email) : ''}`
    : '';
  const idDocTail = isFactura ? '' : tag('IndServicio', 3);

  const encabezado = `<Encabezado><IdDoc>${tag('TipoDTE', document.documentCode)}${tag('Folio', provisionalFolio)}${tag('FchEmis', siiDate(document.sale.completedAt, timeZone))}${idDocTail}${tag('MedioPago', paymentMethodCode)}</IdDoc><Emisor>${tag('RUTEmisor', issuer.rut)}${tag('RznSocEmisor', issuer.legalName)}${tag('GiroEmisor', issuer.activity)}${tag('CdgSIISucur', issuer.branchCode)}${tag('DirOrigen', issuer.address)}${tag('CmnaOrigen', issuer.commune)}${tag('CiudadOrigen', issuer.city)}</Emisor><Receptor>${tag('RUTRecep', receiverRut)}${tag('RznSocRecep', receiverName)}${receptorTail}</Receptor>${totalsXml(document)}</Encabezado>`;
  const details = document.items.map(detailXml).join('');
  const references = referenceXml(document.reference);
  const fiscalTail = tedXml
    ? `${tedXml}${tag('TmstFirma', siiTimestamp(signatureTimestamp || new Date(), timeZone))}`
    : '<!-- TED pendiente de CAF --><!-- Signature pendiente de certificado digital -->';

  return `<?xml version="1.0" encoding="ISO-8859-1"?>\n<DTE version="1.0">\n<Documento ID="${documentId}">${encabezado}${details}${references}${fiscalTail}</Documento>\n</DTE>`;
}
