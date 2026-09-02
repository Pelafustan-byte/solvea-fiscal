export const IVA_RATE = 0.19;
export const EXEMPT_ONLY_CODES = new Set([41, 34]);
export const FACTURA_CODES = new Set([33, 34]);
// Factura, Nota de Crédito y Nota de Débito: PrcItem/MontoItem son netos (sin IVA) y el total se
// obtiene sumando neto + IVA + exento — a diferencia de boleta, donde el total es bruto-incluido
// y el neto se obtiene dividiendo por 1.19.
export const NET_PRICED_CODES = new Set([33, 56, 61]);

function asInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    const error = new Error(`${field} debe ser un entero CLP no negativo.`);
    error.status = 422;
    throw error;
  }
  return number;
}

function lineNetAmount(item) {
  const gross = asInteger(item.subtotal, 'item.subtotal');
  const pct = Number(item.discountPercent) || 0;
  return gross - Math.round((gross * pct) / 100);
}

/**
 * Neto/IVA/total a partir de los ítems (precios netos), aplicando descuento por línea
 * (DescuentoPct sobre MontoItem) y luego descuento global (DscRcgGlobal, sólo sobre ítems
 * afectos) antes de calcular el IVA. Usado por Factura/NC/ND — nunca por Boleta.
 */
export function computeNetPricedTotals({ items, discountPercent = 0 }) {
  let netAffected = 0;
  let exempt = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const netAfterLineDiscount = lineNetAmount(item);
    if (item?.exempt) exempt += netAfterLineDiscount;
    else netAffected += netAfterLineDiscount;
  }
  const globalDiscount = Math.round((netAffected * (Number(discountPercent) || 0)) / 100);
  const net = netAffected - globalDiscount;
  const vat = Math.round(net * IVA_RATE);
  return { net, exempt, vatRate: 19, vat, total: net + vat + exempt };
}

export function computeTaxTotals(document) {
  const documentCode = Number(document?.documentCode);
  const items = Array.isArray(document?.items) ? document.items : [];

  if (EXEMPT_ONLY_CODES.has(documentCode)) {
    const total = asInteger(document?.sale?.total, 'sale.total');
    return { net: 0, exempt: total, vatRate: 0, vat: 0, total };
  }

  if (NET_PRICED_CODES.has(documentCode)) {
    return computeNetPricedTotals({ items, discountPercent: document?.sale?.discountPercent });
  }

  const total = asInteger(document?.sale?.total, 'sale.total');
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

const KIND_BY_CODE = { 33: 'factura', 34: 'factura', 56: 'nota_debito', 61: 'nota_credito' };

export function publicRepresentation({ document, issuer, folio = '', issuedAt = null }) {
  const totals = computeTaxTotals(document);
  const documentCode = Number(document.documentCode);
  const requiresFullReceptor = FACTURA_CODES.has(documentCode) || NET_PRICED_CODES.has(documentCode);
  return {
    kind: KIND_BY_CODE[documentCode] || 'boleta',
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
    recipient: requiresFullReceptor ? {
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
      paymentMethod: document.sale.paymentMethod,
      discountPercent: document.sale.discountPercent || 0
    },
    reference: document.reference || null,
    items: document.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
      exempt: Boolean(item.exempt),
      unitMeasure: item.unitMeasure || '',
      discountPercent: item.discountPercent || 0
    })),
    totals
  };
}
