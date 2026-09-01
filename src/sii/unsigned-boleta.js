import { tag } from '../lib/xml.js';
import { siiDate, siiTimestamp } from './ted.js';

const IVA_RATE = 0.19;

function detailXml(item, index) {
  return `<Detalle>${tag('NroLinDet', index + 1)}${item.sku ? `<CdgItem>${tag('TpoCodigo', 'INT1')}${tag('VlrCodigo', item.sku)}</CdgItem>` : ''}${item.exempt ? tag('IndExe', 1) : ''}${tag('NmbItem', item.name)}${tag('QtyItem', item.quantity)}${item.unitMeasure ? tag('UnmdItem', item.unitMeasure) : ''}${tag('PrcItem', item.unitPrice)}${tag('MontoItem', item.subtotal)}</Detalle>`;
}

function totalsXml(document) {
  if (document.documentCode === 41) {
    return `<Totales>${tag('MntExe', document.sale.total)}${tag('MntTotal', document.sale.total)}</Totales>`;
  }

  const exemptGross = document.items.reduce((sum, item) => sum + (item.exempt ? item.subtotal : 0), 0);
  const affectedGross = document.sale.total - exemptGross;
  const net = Math.round(affectedGross / (1 + IVA_RATE));
  const iva = affectedGross - net;

  return `<Totales>${tag('MntNeto', net)}${exemptGross > 0 ? tag('MntExe', exemptGross) : ''}${tag('IVA', iva)}${tag('MntTotal', document.sale.total)}</Totales>`;
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
  const receiverRut = document.recipient.rut || '66666666-6';
  const receiverName = document.recipient.legalName || 'Consumidor Final';
  const documentId = provisionalFolio > 0
    ? `F${provisionalFolio}T${document.documentCode}`
    : `SOLVEA-DRAFT-${document.sale.id}`;

  const encabezado = `<Encabezado><IdDoc>${tag('TipoDTE', document.documentCode)}${tag('Folio', provisionalFolio)}${tag('FchEmis', siiDate(document.sale.completedAt, timeZone))}${tag('IndServicio', 3)}${tag('MedioPago', paymentMethodCode)}</IdDoc><Emisor>${tag('RUTEmisor', issuer.rut)}${tag('RznSocEmisor', issuer.legalName)}${tag('GiroEmisor', issuer.activity)}${tag('CdgSIISucur', issuer.branchCode)}${tag('DirOrigen', issuer.address)}${tag('CmnaOrigen', issuer.commune)}${tag('CiudadOrigen', issuer.city)}</Emisor><Receptor>${tag('RUTRecep', receiverRut)}${tag('RznSocRecep', receiverName)}</Receptor>${totalsXml(document)}</Encabezado>`;
  const details = document.items.map(detailXml).join('');
  const references = referenceXml(document.reference);
  const fiscalTail = tedXml
    ? `${tedXml}${tag('TmstFirma', siiTimestamp(signatureTimestamp || new Date(), timeZone))}`
    : '<!-- TED pendiente de CAF --><!-- Signature pendiente de certificado digital -->';

  return `<?xml version="1.0" encoding="ISO-8859-1"?>\n<DTE version="1.0">\n<Documento ID="${documentId}">${encabezado}${details}${references}${fiscalTail}</Documento>\n</DTE>`;
}
