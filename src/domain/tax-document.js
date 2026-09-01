import { isValidRut, normalizeRut } from './rut.js';

export const DOCUMENT_TYPES = {
  boleta_afecta: 39,
  boleta_exenta: 41
};

const money = (value) => Number.isInteger(Number(value)) ? Number(value) : NaN;

function fail(message) {
  const error = new Error(message);
  error.status = 422;
  throw error;
}

export function validateIssueRequest(input) {
  if (!input || typeof input !== 'object') fail('Payload JSON requerido.');
  if (!input.idempotencyKey || String(input.idempotencyKey).length > 180) fail('idempotencyKey inválida.');
  if (!DOCUMENT_TYPES[input.documentType]) fail('Botillería San Pablo inicia sólo con boleta_afecta o boleta_exenta.');

  const sale = input.sale || {};
  if (!sale.id) fail('sale.id es obligatorio.');
  if (!sale.number) fail('sale.number es obligatorio.');
  const total = money(sale.total);
  if (!Number.isInteger(total) || total <= 0) fail('sale.total debe ser un entero CLP mayor a cero.');

  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) fail('La boleta requiere al menos un ítem.');
  if (items.length > 1000) fail('La boleta excede 1000 líneas de detalle.');

  let computedTotal = 0;
  let exemptTotal = 0;
  const normalizedItems = items.map((item, index) => {
    const quantity = Number(item.quantity);
    const unitPrice = money(item.unitPrice);
    const subtotal = money(item.subtotal);
    if (!Number.isFinite(quantity) || quantity <= 0) fail(`items[${index}].quantity inválida.`);
    if (!Number.isInteger(unitPrice) || unitPrice < 0) fail(`items[${index}].unitPrice inválido.`);
    if (!Number.isInteger(subtotal) || subtotal < 0) fail(`items[${index}].subtotal inválido.`);
    if (!String(item.name || '').trim()) fail(`items[${index}].name es obligatorio.`);

    const exempt = input.documentType === 'boleta_exenta' ? true : Boolean(item.exempt);
    const unitMeasure = String(item.unitMeasure ?? item.unit ?? '').trim();
    if (unitMeasure.length > 4) fail(`items[${index}].unitMeasure excede 4 caracteres.`);

    computedTotal += subtotal;
    if (exempt) exemptTotal += subtotal;

    return {
      sku: String(item.sku || '').slice(0, 35),
      name: String(item.name).trim().slice(0, 80),
      quantity,
      unitPrice,
      subtotal,
      exempt,
      unitMeasure
    };
  });

  // El POS puede aplicar descuento a nivel de venta; por eso la suma de líneas puede ser mayor al total.
  if (computedTotal < total) fail('La suma de subtotales de ítems no puede ser menor al total de la venta.');
  if (exemptTotal > total) fail('La suma de ítems exentos no puede superar el total de la venta.');

  const discount = Math.max(0, money(sale.discount) || 0);
  const hasAffectedItems = normalizedItems.some((item) => !item.exempt);
  const hasExemptItems = normalizedItems.some((item) => item.exempt);
  if (discount > 0 && hasAffectedItems && hasExemptItems) {
    fail('Las ventas mixtas afectas/exentas con descuento global requieren distribución tributaria por línea.');
  }

  const recipient = input.recipient || {};
  const recipientRut = normalizeRut(recipient.rut);
  if (recipientRut && !isValidRut(recipientRut)) fail('RUT receptor inválido.');

  const rawReference = input.reference || null;
  let reference = null;
  if (rawReference) {
    const code = String(rawReference.code || '').trim();
    const reason = String(rawReference.reason || '').trim();
    if (!code || !reason) fail('reference.code y reference.reason son obligatorios cuando se informa referencia.');
    if (code.length > 18) fail('reference.code excede 18 caracteres.');
    if (reason.length > 90) fail('reference.reason excede 90 caracteres.');
    reference = { code, reason };
  }

  return {
    idempotencyKey: String(input.idempotencyKey),
    documentType: input.documentType,
    documentCode: DOCUMENT_TYPES[input.documentType],
    sale: {
      id: String(sale.id),
      number: String(sale.number),
      subtotal: money(sale.subtotal) || computedTotal,
      discount,
      total,
      paymentMethod: String(sale.paymentMethod || ''),
      completedAt: sale.completedAt || null
    },
    recipient: {
      rut: recipientRut,
      legalName: String(recipient.legalName || '').trim().slice(0, 100)
    },
    items: normalizedItems,
    reference
  };
}

export function paymentCode(method) {
  const value = String(method || '').toLowerCase();
  if (['cash', 'efectivo'].includes(value)) return 1;
  if (['card', 'debit', 'credit', 'webpay', 'mercadopago', 'electronic'].some((item) => value.includes(item))) return 2;
  if (['transfer', 'transferencia'].some((item) => value.includes(item))) return 3;
  if (value.includes('cheque')) return 4;
  return 5;
}
