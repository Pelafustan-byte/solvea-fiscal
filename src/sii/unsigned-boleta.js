import { computeTaxTotals, FACTURA_CODES, NET_PRICED_CODES } from '../domain/totals.js';
import { tag } from '../lib/xml.js';
import { siiDate, siiTimestamp } from './ted.js';

function detailXml(item, index) {
  const discountTail = item.discountPercent > 0
    ? `${tag('DescuentoPct', item.discountPercent)}${tag('DescuentoMonto', Math.round((item.subtotal * item.discountPercent) / 100))}`
    : '';
  return `<Detalle>${tag('NroLinDet', index + 1)}${item.sku ? `<CdgItem>${tag('TpoCodigo', 'INT1')}${tag('VlrCodigo', item.sku)}</CdgItem>` : ''}${item.exempt ? tag('IndExe', 1) : ''}${tag('NmbItem', item.name)}${tag('QtyItem', item.quantity)}${item.unitMeasure ? tag('UnmdItem', item.unitMeasure) : ''}${tag('PrcItem', item.unitPrice)}${tag('MontoItem', item.subtotal)}${discountTail}</Detalle>`;
}

function totalsXml(document) {
  const totals = computeTaxTotals(document);
  if ([41, 34].includes(Number(document.documentCode))) {
    return `<Totales>${tag('MntExe', totals.exempt)}${tag('MntTotal', totals.total)}</Totales>`;
  }
  return `<Totales>${tag('MntNeto', totals.net)}${totals.exempt > 0 ? tag('MntExe', totals.exempt) : ''}${tag('IVA', totals.vat)}${tag('MntTotal', totals.total)}</Totales>`;
}

// DscRcgGlobal: descuento/recargo que afecta al total del documento (sólo sobre ítems afectos).
// Orden verificado contra DTE_v10.xsd oficial: NroLinDR, TpoMov, GlosaDR?, TpoValor, ValorDR, ...
function dscRcgGlobalXml(sale) {
  const pct = Number(sale?.discountPercent) || 0;
  if (pct <= 0) return '';
  return `<DscRcgGlobal>${tag('NroLinDR', 1)}${tag('TpoMov', 'D')}${tag('TpoValor', '%')}${tag('ValorDR', pct)}</DscRcgGlobal>`;
}

// Referencia: orden verificado contra DTE_v10.xsd oficial: NroLinRef, TpoDocRef, IndGlobal?,
// FolioRef, RUTOtr?, FchRef, CodRef?, RazonRef?. TpoDocRef/FolioRef/FchRef sólo se informan
// cuando la referencia apunta a un documento (NC/ND) — boleta sólo usaba CodRef/RazonRef.
function referenceXml(reference, timeZone) {
  if (!reference) return '';
  const documentRefTail = reference.documentType
    ? `${tag('TpoDocRef', reference.documentType)}${tag('FolioRef', reference.folio)}${tag('FchRef', siiDate(reference.date, timeZone))}`
    : '';
  return `<Referencia>${tag('NroLinRef', 1)}${documentRefTail}${tag('CodRef', reference.code)}${tag('RazonRef', reference.reason)}</Referencia>`;
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
  const documentCode = Number(document.documentCode);
  const isFactura = FACTURA_CODES.has(documentCode);
  const requiresExtendedReceptor = isFactura || NET_PRICED_CODES.has(documentCode);
  const receiverRut = document.recipient.rut || (requiresExtendedReceptor ? '' : '66666666-6');
  const receiverName = document.recipient.legalName || (requiresExtendedReceptor ? '' : 'Consumidor Final');
  const documentId = provisionalFolio > 0
    ? `F${provisionalFolio}T${document.documentCode}`
    : `SOLVEA-DRAFT-${document.sale.id}`;

  const receptorTail = requiresExtendedReceptor
    ? `${tag('GiroRecep', document.recipient.activity)}${tag('DirRecep', document.recipient.address)}${tag('CmnaRecep', document.recipient.commune)}${tag('CiudadRecep', document.recipient.city)}${document.recipient.email ? tag('CorreoRecep', document.recipient.email) : ''}`
    : '';
  const idDocTail = requiresExtendedReceptor ? '' : tag('IndServicio', 3);

  const encabezado = `<Encabezado><IdDoc>${tag('TipoDTE', document.documentCode)}${tag('Folio', provisionalFolio)}${tag('FchEmis', siiDate(document.sale.completedAt, timeZone))}${idDocTail}${tag('MedioPago', paymentMethodCode)}</IdDoc><Emisor>${tag('RUTEmisor', issuer.rut)}${tag('RznSocEmisor', issuer.legalName)}${tag('GiroEmisor', issuer.activity)}${tag('CdgSIISucur', issuer.branchCode)}${tag('DirOrigen', issuer.address)}${tag('CmnaOrigen', issuer.commune)}${tag('CiudadOrigen', issuer.city)}</Emisor><Receptor>${tag('RUTRecep', receiverRut)}${tag('RznSocRecep', receiverName)}${receptorTail}</Receptor>${totalsXml(document)}</Encabezado>`;
  const details = document.items.map(detailXml).join('');
  const dscRcgGlobal = dscRcgGlobalXml(document.sale);
  const references = referenceXml(document.reference, timeZone);
  const fiscalTail = tedXml
    ? `${tedXml}${tag('TmstFirma', siiTimestamp(signatureTimestamp || new Date(), timeZone))}`
    : '<!-- TED pendiente de CAF --><!-- Signature pendiente de certificado digital -->';

  return `<?xml version="1.0" encoding="ISO-8859-1"?>\n<DTE version="1.0">\n<Documento ID="${documentId}">${encabezado}${details}${dscRcgGlobal}${references}${fiscalTail}</Documento>\n</DTE>`;
}
