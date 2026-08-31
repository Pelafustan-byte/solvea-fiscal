import { tag } from '../lib/xml.js';

const dateOnly = (value) => {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
};

function detailXml(item, index) {
  return `<Detalle>${tag('NroLinDet', index + 1)}${item.sku ? `<CdgItem>${tag('TpoCodigo', 'INT1')}${tag('VlrCodigo', item.sku)}</CdgItem>` : ''}${tag('NmbItem', item.name)}${tag('QtyItem', item.quantity)}${tag('PrcItem', item.unitPrice)}${tag('MontoItem', item.subtotal)}</Detalle>`;
}

export function buildUnsignedBoletaDraft({ document, issuer, provisionalFolio = 0, paymentMethodCode = 5 }) {
  const receiverRut = document.recipient.rut || '66666666-6';
  const receiverName = document.recipient.legalName || 'Consumidor Final';

  const encabezado = `<Encabezado><IdDoc>${tag('TipoDTE', document.documentCode)}${tag('Folio', provisionalFolio)}${tag('FchEmis', dateOnly(document.sale.completedAt))}${tag('IndServicio', 3)}${tag('MedioPago', paymentMethodCode)}</IdDoc><Emisor>${tag('RUTEmisor', issuer.rut)}${tag('RznSocEmisor', issuer.legalName)}${tag('GiroEmisor', issuer.activity)}${tag('CdgSIISucur', issuer.branchCode)}${tag('DirOrigen', issuer.address)}${tag('CmnaOrigen', issuer.commune)}${tag('CiudadOrigen', issuer.city)}</Emisor><Receptor>${tag('RUTRecep', receiverRut)}${tag('RznSocRecep', receiverName)}</Receptor><Totales>${tag('MntTotal', document.sale.total)}</Totales></Encabezado>`;
  const details = document.items.map(detailXml).join('');

  return `<?xml version="1.0" encoding="ISO-8859-1"?><DTE version="1.0"><Documento ID="SOLVEA-DRAFT-${document.sale.id}">${encabezado}${details}<!-- TED pendiente de CAF --><!-- Signature pendiente de certificado digital --></Documento></DTE>`;
}
