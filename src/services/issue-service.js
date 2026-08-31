import { createHash, randomUUID } from 'node:crypto';
import { validateIssueRequest, paymentCode } from '../domain/tax-document.js';
import { buildUnsignedBoletaDraft } from '../sii/unsigned-boleta.js';

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class IssueService {
  #records = new Map();

  constructor(config) {
    this.config = config;
  }

  issue(input) {
    const document = validateIssueRequest(input);
    const payloadHash = fingerprint(document);
    const previous = this.#records.get(document.idempotencyKey);

    if (previous) {
      if (previous.payloadHash !== payloadHash) {
        const error = new Error('La idempotencyKey ya fue utilizada con otro contenido.');
        error.status = 409;
        throw error;
      }
      return previous.response;
    }

    if (this.config.mode !== 'development') {
      const error = new Error('La emisión SII todavía no está habilitada: faltan CAF/TED/firma/envío y certificación.');
      error.status = 503;
      throw error;
    }

    const externalId = `sf_${randomUUID()}`;
    const xml = buildUnsignedBoletaDraft({
      document,
      issuer: this.config.issuer,
      paymentMethodCode: paymentCode(document.sale.paymentMethod)
    });

    const response = {
      id: externalId,
      externalId,
      status: 'processing',
      folio: '',
      xml,
      pdfUrl: '',
      sii: {
        submitted: false,
        trackId: '',
        accepted: false
      },
      development: true,
      warning: 'Borrador sin validez tributaria. No contiene CAF, TED, firma XML ni recepción SII.',
      document: {
        type: document.documentType,
        code: document.documentCode,
        saleId: document.sale.id,
        saleNumber: document.sale.number,
        total: document.sale.total
      }
    };

    this.#records.set(document.idempotencyKey, { payloadHash, response });
    return response;
  }
}
