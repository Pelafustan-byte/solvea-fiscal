import { issuerMissingFields, submissionMissingFields, configuredCaf } from '../services/issue-service.js';
import { readiness } from '../config.js';

// Datos oficiales del "Set de Pruebas" SII BE (boleta electrónica), casos 1 a 5.
// Mismos ítems/cantidades/precios que test/certification-set.test.js — no inventar valores nuevos aquí.
export const CERTIFICATION_CASES = [
  {
    caso: 1,
    items: [
      { name: 'Cambio de aceite', quantity: 1, unitPrice: 19900, subtotal: 19900 },
      { name: 'Alineacion y balanceo', quantity: 1, unitPrice: 9900, subtotal: 9900 }
    ]
  },
  {
    caso: 2,
    items: [{ name: 'Papel de regalo', quantity: 17, unitPrice: 120, subtotal: 2040 }]
  },
  {
    caso: 3,
    items: [
      { name: 'Sandwic', quantity: 2, unitPrice: 1500, subtotal: 3000 },
      { name: 'Bebida', quantity: 2, unitPrice: 550, subtotal: 1100 }
    ]
  },
  {
    caso: 4,
    items: [
      { name: 'item afecto 1', quantity: 8, unitPrice: 1590, subtotal: 12720 },
      { name: 'item exento 2', quantity: 2, unitPrice: 1000, subtotal: 2000, exempt: true }
    ]
  },
  {
    caso: 5,
    items: [{ name: 'Arroz', quantity: 5, unitPrice: 700, subtotal: 3500, unitMeasure: 'Kg.' }]
  }
];

export function certificationCaseRequest(caso) {
  const definition = CERTIFICATION_CASES.find((item) => item.caso === caso);
  if (!definition) throw new Error(`Caso de certificación desconocido: ${caso}.`);
  const total = definition.items.reduce((sum, item) => sum + item.subtotal, 0);
  return {
    idempotencyKey: `certification-set-caso-${caso}`,
    documentType: 'boleta_afecta',
    sale: {
      id: `SET-${caso}`,
      number: `SET-${caso}`,
      total,
      paymentMethod: 'efectivo',
      completedAt: new Date().toISOString()
    },
    items: definition.items,
    reference: { code: 'SET', reason: `CASO-${caso}` }
  };
}

/**
 * Prepara los 5 casos oficiales usando IssueService#prepare (sin reservar folio, sin tocar SII).
 */
export async function prepareCertificationSet(issueService) {
  const results = [];
  for (const definition of CERTIFICATION_CASES) {
    const request = certificationCaseRequest(definition.caso);
    try {
      const prepared = await issueService.prepare(request);
      results.push({
        caso: definition.caso,
        reference: `SET / CASO-${definition.caso}`,
        documentType: prepared.documentType,
        documentCode: prepared.documentCode,
        total: prepared.document.total,
        totals: prepared.document.totals,
        folio: null,
        estadoXml: 'preparado',
        estadoSii: 'pendiente',
        trackId: null,
        error: null
      });
    } catch (error) {
      results.push({
        caso: definition.caso,
        reference: `SET / CASO-${definition.caso}`,
        documentType: 'boleta_afecta',
        documentCode: 39,
        total: null,
        totals: null,
        folio: null,
        estadoXml: 'error',
        estadoSii: 'pendiente',
        trackId: null,
        error: error.message
      });
    }
  }
  return results;
}

/**
 * Valida que el Set de Certificación esté listo para emitir, SIN reservar folios ni
 * consultar al SII. Devuelve { ready, errors, notes }.
 */
export async function validateCertificationSet(config, preparedResults) {
  const errors = [];
  const notes = [];

  if (preparedResults.length !== 5) errors.push(`Se esperaban 5 casos, hay ${preparedResults.length}.`);
  for (const result of preparedResults) {
    if (result.error) { errors.push(`CASO-${result.caso}: ${result.error}`); continue; }
    if (result.documentCode !== 39) errors.push(`CASO-${result.caso}: TipoDTE ${result.documentCode} distinto de 39.`);
    if (result.reference !== `SET / CASO-${result.caso}`) errors.push(`CASO-${result.caso}: referencia SET/CASO-X inválida.`);
    const totals = result.totals;
    if (totals && (totals.net + totals.exempt + totals.vat) !== totals.total) {
      errors.push(`CASO-${result.caso}: neto + exento + IVA no cuadra con el total.`);
    }
  }

  const issuerMissing = issuerMissingFields(config);
  if (issuerMissing.length) errors.push(`Datos de emisor incompletos: ${issuerMissing.join(', ')}.`);

  let caf = null;
  try {
    caf = configuredCaf(config, 39);
  } catch (error) {
    errors.push(`CAF 39 inválido: ${error.message}`);
  }
  if (!caf) errors.push('CAF 39 no configurado.');

  if (!config.credentials?.certificatePfxBase64) errors.push('Certificado digital (SII_CERT_PFX_BASE64) no configurado.');

  const submissionMissing = submissionMissingFields(config);
  if (submissionMissing.length) errors.push(`Configuración de envío SII incompleta: ${submissionMissing.join(', ')}.`);

  const ready = readiness(config);
  if (!ready.submissionReady) errors.push('GET /v1/readiness reporta submissionReady=false.');

  notes.push('RCOF/Resumen de Ventas Diarias: obligación eliminada desde 2022-08-01 (Resolución Ex. SII N°53/2022) — no se genera ni envía por separado. Confirmar con Mesa de Ayuda SII si el correo de certificación aún lo exige.');
  if (!config.sii?.certificationSubmissionEnabled) {
    notes.push('SII_CERTIFICATION_SUBMISSION_ENABLED=false: el set puede validarse pero no puede emitirse ni enviarse todavía.');
  }

  return {
    ready: errors.length === 0,
    errors,
    notes,
    verdict: errors.length === 0 ? 'SET LISTO PARA EMISIÓN' : `SET NO LISTO (${errors.length} error(es))`
  };
}
