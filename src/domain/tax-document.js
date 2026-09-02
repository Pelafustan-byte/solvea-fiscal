import { isValidRut, normalizeRut } from './rut.js';
import { NET_PRICED_CODES } from './totals.js';

export const DOCUMENT_TYPES = {
  boleta_afecta: 39,
  boleta_exenta: 41,
  factura_afecta: 33,
  factura_exenta: 34,
  nota_credito: 61,
  nota_debito: 56
};

// Factura, Nota de Crédito y Nota de Débito exigen identificación completa del receptor.
const FULL_RECEPTOR_CODES = new Set([33, 34, 56, 61]);
export const EXEMPT_CODES = new Set([41, 34]);
const percent = (value) => Number.isFinite(Number(value)) ? Number(value) : NaN;

const money = (value) => Number.isInteger(Number(value)) ? Number(value) : NaN;

function fail(message) {
  const error = new Error(message);
  error.status = 422;
  throw error;
}

export function validateIssueRequest(input) {
  if (!input || typeof input !== 'object') fail('Payload JSON requerido.');
  if (!input.idempotencyKey || String(input.idempotencyKey).length > 180) fail('idempotencyKey inválida.');
  if (!DOCUMENT_TYPES[input.documentType]) fail('documentType debe ser boleta_afecta, boleta_exenta, factura_afecta, factura_exenta, nota_credito o nota_debito.');

  const sale = input.sale || {};
  if (!sale.id) fail('sale.id es obligatorio.');
  if (!sale.number) fail('sale.number es obligatorio.');
  const total = money(sale.total);
  if (!Number.isInteger(total) || total <= 0) fail('sale.total debe ser un entero CLP mayor a cero.');

  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) fail('La boleta requiere al menos un ítem.');
  if (items.length > 1000) fail('La boleta excede 1000 líneas de detalle.');

  const documentCode = DOCUMENT_TYPES[input.documentType];
  const isNetPriced = NET_PRICED_CODES.has(documentCode);

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

    const exempt = EXEMPT_CODES.has(documentCode) ? true : Boolean(item.exempt);
    const unitMeasure = String(item.unitMeasure ?? item.unit ?? '').trim();
    if (unitMeasure.length > 4) fail(`items[${index}].unitMeasure excede 4 caracteres.`);

    const discountPercentRaw = item.discountPercent;
    const discountPercent = discountPercentRaw === undefined || discountPercentRaw === null || discountPercentRaw === ''
      ? 0 : percent(discountPercentRaw);
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      fail(`items[${index}].discountPercent debe estar entre 0 y 100.`);
    }

    computedTotal += subtotal;
    if (exempt) exemptTotal += subtotal;

    return {
      sku: String(item.sku || '').slice(0, 35),
      name: String(item.name).trim().slice(0, 80),
      quantity,
      unitPrice,
      subtotal,
      exempt,
      unitMeasure,
      discountPercent
    };
  });

  // El POS puede aplicar descuento a nivel de venta; por eso la suma de líneas puede ser mayor al total.
  // Para Factura/NC/ND (isNetPriced) los ítems son precios netos y el total incluye IVA agregado —
  // esa comparación bruto-incluido no aplica; el total real lo calcula computeTaxTotals a partir
  // de los ítems (ver domain/totals.js), no se contrasta aquí contra sale.total.
  if (!isNetPriced && computedTotal < total) fail('La suma de subtotales de ítems no puede ser menor al total de la venta.');
  if (exemptTotal > total && !isNetPriced) fail('La suma de ítems exentos no puede superar el total de la venta.');

  const discount = Math.max(0, money(sale.discount) || 0);
  const hasAffectedItems = normalizedItems.some((item) => !item.exempt);
  const hasExemptItems = normalizedItems.some((item) => item.exempt);
  if (discount > 0 && hasAffectedItems && hasExemptItems) {
    fail('Las ventas mixtas afectas/exentas con descuento global requieren distribución tributaria por línea.');
  }

  const discountPercentRaw = sale.discountPercent;
  const discountPercent = discountPercentRaw === undefined || discountPercentRaw === null || discountPercentRaw === ''
    ? 0 : percent(discountPercentRaw);
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    fail('sale.discountPercent debe estar entre 0 y 100.');
  }

  const recipient = input.recipient || {};
  const recipientRut = normalizeRut(recipient.rut);
  if (recipientRut && !isValidRut(recipientRut)) fail('RUT receptor inválido.');
  const recipientEmail = String(recipient.email || '').trim().slice(0, 80);
  if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) fail('recipient.email inválido.');

  if (FULL_RECEPTOR_CODES.has(documentCode)) {
    if (!recipientRut || !isValidRut(recipientRut)) fail('La factura requiere recipient.rut válido.');
    if (!String(recipient.legalName || '').trim()) fail('La factura requiere recipient.legalName.');
    if (!String(recipient.activity || '').trim()) fail('La factura requiere recipient.activity (giro).');
    if (!String(recipient.address || '').trim()) fail('La factura requiere recipient.address.');
    if (!String(recipient.commune || '').trim()) fail('La factura requiere recipient.commune.');
  }

  const isNoteType = documentCode === 56 || documentCode === 61;
  const rawReference = input.reference || null;
  let reference = null;
  if (rawReference) {
    const code = String(rawReference.code || '').trim();
    const reason = String(rawReference.reason || '').trim();
    if (!code || !reason) fail('reference.code y reference.reason son obligatorios cuando se informa referencia.');
    if (code.length > 18) fail('reference.code excede 18 caracteres.');
    if (reason.length > 90) fail('reference.reason excede 90 caracteres.');
    reference = { code, reason };
    if (isNoteType) {
      const referencedDocumentType = Number(rawReference.documentType);
      const referencedFolio = Number(rawReference.folio);
      const referencedDate = String(rawReference.date || '').trim();
      if (!Number.isInteger(referencedDocumentType) || referencedDocumentType <= 0) {
        fail('reference.documentType (TipoDTE referenciado) es obligatorio para nota_credito/nota_debito.');
      }
      if (!Number.isInteger(referencedFolio) || referencedFolio <= 0) {
        fail('reference.folio es obligatorio para nota_credito/nota_debito.');
      }
      if (!referencedDate) fail('reference.date es obligatorio para nota_credito/nota_debito.');
      reference = { ...reference, documentType: referencedDocumentType, folio: referencedFolio, date: referencedDate };
    }
  } else if (isNoteType) {
    fail('nota_credito/nota_debito requieren reference (documento que referencian).');
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
      discountPercent,
      total,
      paymentMethod: String(sale.paymentMethod || ''),
      completedAt: sale.completedAt || null
    },
    recipient: {
      rut: recipientRut,
      legalName: String(recipient.legalName || '').trim().slice(0, 100),
      activity: String(recipient.activity || '').trim().slice(0, 40),
      address: String(recipient.address || '').trim().slice(0, 70),
      commune: String(recipient.commune || '').trim().slice(0, 20),
      city: String(recipient.city || '').trim().slice(0, 20),
      email: recipientEmail
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
