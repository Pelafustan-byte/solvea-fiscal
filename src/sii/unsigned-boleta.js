import { tag } from '../lib/xml.js';
import { siiDate } from './ted.js';

function detailXml(item, index) {
  return `<Detalle>${tag('NroLinDet', index + 1)}${item.sku ? `<CdgItem>${tag('TpoCodigo', 'INT1')}${tag('VlrCodigo', item.sku)}</CdgItem>` : ''}${tag('NmbItem', item.name)}${tag('QtyItem', item.quantity)}${tag('PrcItem', item.unitPrice)}${tag('MontoItem', item.subtotal)}</Detalle>`;
}

export function buildUnsignedBoletaDraft({
  document,
  issuer,
  provisionalFolio = 0,
  paymentMethodCode = 5,
  tedXml = '',
  timeZone = 'America/Santiago'
}) {
  const receiverRut = document.recipient.rut || '66666666-6';
  const receiverName = document.recipient.legalName || 'Consumidor Final';
  const documentId = provisionalFolio > 0
    ? `SOLVEA-B${document.documentCode}-${provisionalFolio}`
    : `SOLVEA-DRAFT-${document.sale.id}`;

  const encabezado = `<Encabezado><IdDoc>${tag('TipoDTE', document.documentCode)}${tag('Folio', provisionalFolio)}${tag('FchEmis', siiDate(document.sale.completedAt, timeZone))}${tag('IndServicio', 3)}${tag('MedioPago', paymentMethodCode)}</IdDoc><Emisor>${tag('RUTEmisor', issuer.rut)}${tag('RznSocEmisor', issuer.legalName)}${tag('GiroEmisor', issuer.activity)}${tag('CdgSIISucur', issuer.branchCode)}${tag('DirOrigen', issuer.address)}${tag('CmnaOrigen', issuer.commune)}${tag('CiudadOrigen', issuer.city)}</Emisor><Receptor>${tag('RUTRecep', receiverRut)}${tag('RznSocRecep', receiverName)}</Receptor><Totales>${tag('MntTotal', document.sale.total)}</Totales></Encabezado>`;
  const details = document.items.map(detailXml).join('');
  const fiscalTail = tedXml
    ? `${tedXml}<!-- Signature XMLDSIG pendiente de certificado digital -->`
    : '<!-- TED pendiente de CAF --><!-- Signature pendiente de certificado digital -->';

  return `<?xml version="1.0" encoding="ISO-8859-1"?><DTE version="1.0"><Documento ID="${documentId}">${encabezado}${details}${fiscalTail}</Documento></DTE>`;
}
