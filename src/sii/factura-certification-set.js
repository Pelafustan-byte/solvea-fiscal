// Datos oficiales del "Set Básico" de certificación de Factura Electrónica del SII
// (Número de atención 5046689, archivo SIISetDePruebas778084066.txt del contribuyente).
// Ítems/cantidades/precios unitarios/descuentos copiados tal cual del set oficial — no inventar
// valores nuevos aquí. Los casos 5, 7 y 8 (Notas sin montos propios en el instructivo) reutilizan
// los ítems del caso que referencian, tal como exige el SII para NC de corrección de texto/anulación
// (deben reproducir el documento original). El caso 6 (devolución parcial) reutiliza el precio
// unitario y el descuento por línea del caso 2, con las cantidades devueltas que sí informa el set.
//
// PLACEHOLDER_FOLIO: como este set aún no reserva folios reales, FolioRef usa el número de caso
// referenciado como marcador de vista previa — se debe reemplazar por el folio real una vez que la
// Fase B (envío real) reserve folios de verdad.

const RECIPIENT = {
  rut: '11111111-1',
  legalName: 'CLIENTE CERTIFICACION SII',
  activity: 'GIRO GENERICO CERTIFICACION',
  address: 'DIRECCION CERTIFICACION 123',
  commune: 'SANTIAGO'
};

const FACTURA_ITEMS = {
  1: [
    { name: 'Cajón AFECTO', quantity: 159, unitPrice: 2978, subtotal: 473502 },
    { name: 'Relleno AFECTO', quantity: 67, unitPrice: 4947, subtotal: 331449 }
  ],
  2: [
    { name: 'Pañuelo AFECTO', quantity: 654, unitPrice: 5086, subtotal: 3326244, discountPercent: 8 },
    { name: 'ITEM 2 AFECTO', quantity: 595, unitPrice: 4140, subtotal: 2463300, discountPercent: 19 }
  ],
  3: [
    { name: 'Pintura B&W AFECTO', quantity: 51, unitPrice: 5966, subtotal: 304266 },
    { name: 'ITEM 2 AFECTO', quantity: 219, unitPrice: 3761, subtotal: 823659 },
    { name: 'ITEM 3 SERVICIO EXENTO', quantity: 1, unitPrice: 35175, subtotal: 35175, exempt: true }
  ],
  4: [
    { name: 'ITEM 1 AFECTO', quantity: 348, unitPrice: 5071, subtotal: 1764708 },
    { name: 'ITEM 2 AFECTO', quantity: 147, unitPrice: 6047, subtotal: 888909 },
    { name: 'ITEM 3 SERVICIO EXENTO', quantity: 2, unitPrice: 6820, subtotal: 13640, exempt: true }
  ]
};

export const FACTURA_CERTIFICATION_CASES = [
  { caso: 1, documentType: 'factura_afecta', items: FACTURA_ITEMS[1] },
  { caso: 2, documentType: 'factura_afecta', items: FACTURA_ITEMS[2] },
  { caso: 3, documentType: 'factura_afecta', items: FACTURA_ITEMS[3] },
  { caso: 4, documentType: 'factura_afecta', items: FACTURA_ITEMS[4], saleDiscountPercent: 19 },
  {
    caso: 5,
    documentType: 'nota_credito',
    items: FACTURA_ITEMS[1],
    referencesCaso: 1,
    codRef: 2,
    reason: 'CORRIGE GIRO DEL RECEPTOR'
  },
  {
    caso: 6,
    documentType: 'nota_credito',
    items: [
      { name: 'Pañuelo AFECTO', quantity: 240, unitPrice: 5086, subtotal: 240 * 5086, discountPercent: 8 },
      { name: 'ITEM 2 AFECTO', quantity: 403, unitPrice: 4140, subtotal: 403 * 4140, discountPercent: 19 }
    ],
    referencesCaso: 2,
    codRef: 3,
    reason: 'DEVOLUCION DE MERCADERIAS'
  },
  {
    caso: 7,
    documentType: 'nota_credito',
    items: FACTURA_ITEMS[3],
    referencesCaso: 3,
    codRef: 1,
    reason: 'ANULA FACTURA'
  },
  {
    caso: 8,
    documentType: 'nota_debito',
    items: FACTURA_ITEMS[1],
    referencesCaso: 5,
    referencedDocumentType: 61,
    codRef: 1,
    reason: 'ANULA NOTA DE CREDITO ELECTRONICA'
  }
];

function referencedDocumentCode(definition) {
  if (definition.referencedDocumentType) return definition.referencedDocumentType;
  return 33; // casos 5, 6 y 7 referencian facturas (33)
}

export function facturaCertificationCaseRequest(caso, { timestamp = new Date().toISOString() } = {}) {
  const definition = FACTURA_CERTIFICATION_CASES.find((item) => item.caso === caso);
  if (!definition) throw new Error(`Caso de certificación de factura desconocido: ${caso}.`);

  const isNote = definition.documentType === 'nota_credito' || definition.documentType === 'nota_debito';
  const reference = isNote ? {
    code: String(definition.codRef),
    reason: definition.reason,
    documentType: referencedDocumentCode(definition),
    folio: definition.referencesCaso, // ver PLACEHOLDER_FOLIO arriba
    date: timestamp // siiDate() formatea a AAAA-MM-DD en el timezone de emisión, igual que FchEmis
  } : { code: 'SET-FACTURA', reason: `CASO-${caso}` };

  // sale.total sólo debe pasar la validación "> 0"; para factura/NC/ND (net-priced) el total real
  // que termina en el DTE lo calcula computeTaxTotals a partir de los ítems (ver domain/totals.js),
  // no este valor — ver la nota en tax-document.js sobre isNetPriced.
  const placeholderTotal = definition.items.reduce((sum, item) => sum + item.subtotal, 0) || 1;

  return {
    idempotencyKey: `factura-certification-set-caso-${caso}`,
    documentType: definition.documentType,
    sale: {
      id: `SET-FAC-${caso}`,
      number: `SET-FAC-${caso}`,
      total: placeholderTotal,
      discountPercent: definition.saleDiscountPercent || 0,
      paymentMethod: 'transferencia',
      completedAt: timestamp
    },
    recipient: RECIPIENT,
    items: definition.items,
    reference
  };
}

/**
 * Prepara (sólo validación + XML, sin folio real ni SII) los 8 casos del Set Básico de Factura.
 */
export async function prepareFacturaCertificationSet(issueService) {
  const timestamp = new Date().toISOString();
  const results = [];
  for (const definition of FACTURA_CERTIFICATION_CASES) {
    const request = facturaCertificationCaseRequest(definition.caso, { timestamp });
    try {
      const prepared = await issueService.prepare(request);
      results.push({
        caso: definition.caso,
        documentType: prepared.documentType,
        documentCode: prepared.documentCode,
        reference: request.reference,
        total: prepared.document.total,
        totals: prepared.document.totals,
        xml: prepared.xml,
        error: null
      });
    } catch (error) {
      results.push({
        caso: definition.caso,
        documentType: definition.documentType,
        documentCode: null,
        reference: request.reference,
        total: null,
        totals: null,
        xml: null,
        error: error.message
      });
    }
  }
  return results;
}
