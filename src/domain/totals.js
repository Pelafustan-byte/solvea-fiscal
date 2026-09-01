export const IVA_RATE = 0.19;
export const EXEMPT_ONLY_CODES = new Set([41, 34]);
export const FACTURA_CODES = new Set([33, 34]);

function asInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    const error = new Error(`${field} debe ser un entero CLP no negativo.`);
    error.status = 422;
    throw error;
  }
  return number;
}

export function computeTaxTotals(document) {
  const total = asInteger(document?.sale?.total, 'sale.total');
  const items = Array.isArray(document?.items) ? document.items : [];

  if (EXEMPT_ONLY_CODES.has(Number(document?.documentCode))) {
    return { net: 0, exempt: total, vatRate: 0, vat: 0, total };
  }

  const exempt = items.reduce((sum, item) => sum + (item?.exempt ? asInteger(item.subtotal, 'item.subtotal') : 0), 0);
  if (exempt > total) {
    const error = new Error('El monto exento no puede superar el total de la boleta.');
    error.status = 422;
    throw error;
  }

  const affectedGross = total - exempt;
  const net = Math.round(affectedGross / (1 + IVA_RATE));
  const vat = affectedGross - net;

  return { net, exempt, vatRate: 19, vat, total };
}

export function publicRepresentation({ document, issuer, folio = '', issuedAt = null }) {
  const totals = computeTaxTotals(document);
  const isFactura = FACTURA_CODES.has(Number(document.documentCode));
  return {
    kind: isFactura ? 'factura' : 'boleta',
    documentType: document.documentType,
    documentCode: document.documentCode,
    folio: String(folio || ''),
    issuedAt: issuedAt || document.sale.completedAt || null,
    issuer: {
      rut: String(issuer?.rut || ''),
      legalName: String(issuer?.legalName || ''),
      activity: String(issuer?.activity || ''),
      address: String(issuer?.address || ''),
      commune: String(issuer?.commune || ''),
      city: String(issuer?.city || '')
    },
    recipient: isFactura ? {
      rut: String(document.recipient?.rut || ''),
      legalName: String(document.recipient?.legalName || ''),
      activity: String(document.recipient?.activity || ''),
      address: String(document.recipient?.address || ''),
      commune: String(document.recipient?.commune || ''),
      city: String(document.recipient?.city || ''),
      email: String(document.recipient?.email || '')
    } : undefined,
    sale: {
      id: document.sale.id,
      number: document.sale.number,
      paymentMethod: document.sale.paymentMethod
    },
    items: document.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
      exempt: Boolean(item.exempt),
      unitMeasure: item.unitMeasure || ''
    })),
    totals
  };
}
