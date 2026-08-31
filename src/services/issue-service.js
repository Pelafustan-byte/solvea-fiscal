import { createHash } from 'node:crypto';
import { validateIssueRequest, paymentCode } from '../domain/tax-document.js';
import { assertCafCompatible, decodeCafBase64, parseCaf } from '../sii/caf.js';
import { buildTed } from '../sii/ted.js';
import { buildUnsignedBoletaDraft } from '../sii/unsigned-boleta.js';
import { createFolioStore } from './folio-store.js';

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function externalIdFor(idempotencyKey) {
  return `sf_${createHash('sha256').update(`solvea-fiscal:${idempotencyKey}`).digest('hex').slice(0, 24)}`;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function configuredCaf(config, documentCode) {
  const value = documentCode === 41 ? config.credentials?.caf41Base64 : config.credentials?.caf39Base64;
  if (!value) return null;
  return parseCaf(decodeCafBase64(value));
}

function assertIssuerConfigured(config) {
  const required = ['rut', 'legalName', 'activity', 'address', 'commune', 'city'];
  const missing = required.filter((key) => !String(config.issuer?.[key] || '').trim());
  if (missing.length) throw httpError(503, `Faltan datos del emisor: ${missing.join(', ')}.`);
}

export class IssueService {
  #records = new Map();

  constructor(config, { folioStore } = {}) {
    this.config = config;
    this.folioStore = folioStore || createFolioStore(config);
  }

  async issue(input) {
    const document = validateIssueRequest(input);
    const payloadHash = fingerprint(document);
    const previous = this.#records.get(document.idempotencyKey);

    if (previous) {
      if (previous.payloadHash !== payloadHash) throw httpError(409, 'La idempotencyKey ya fue utilizada con otro contenido.');
      return previous.response;
    }

    if (this.config.mode === 'production') {
      throw httpError(503, 'Producción SII permanece bloqueada hasta completar firma XMLDSIG, autenticación, envío, seguimiento y certificación.');
    }

    const caf = configuredCaf(this.config, document.documentCode);
    const externalId = externalIdFor(document.idempotencyKey);

    if (!caf) {
      if (this.config.mode !== 'development') {
        throw httpError(503, `Falta CAF de certificación para TipoDTE ${document.documentCode}.`);
      }

      const xml = buildUnsignedBoletaDraft({
        document,
        issuer: this.config.issuer,
        paymentMethodCode: paymentCode(document.sale.paymentMethod),
        timeZone: this.config.timeZone
      });
      const response = {
        id: externalId,
        externalId,
        status: 'processing',
        folio: '',
        xml,
        pdfUrl: '',
        sii: { submitted: false, trackId: '', accepted: false },
        development: true,
        fiscalStage: 'draft_without_caf',
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

    assertIssuerConfigured(this.config);
    assertCafCompatible(caf, { issuerRut: this.config.issuer.rut, documentType: document.documentCode });
    if (this.config.mode === 'certification' && !this.config.stateDir) {
      throw httpError(503, 'SOLVEA_FISCAL_STATE_DIR es obligatorio en certificación para persistir reservas de folio.');
    }

    const reservation = await this.folioStore.reserve({
      caf,
      idempotencyKey: document.idempotencyKey,
      payloadHash,
      timestamp: new Date().toISOString()
    });
    const ted = buildTed({
      document,
      issuer: this.config.issuer,
      caf,
      folio: reservation.folio,
      timestamp: reservation.timestamp,
      timeZone: this.config.timeZone
    });
    const xml = buildUnsignedBoletaDraft({
      document,
      issuer: this.config.issuer,
      provisionalFolio: reservation.folio,
      paymentMethodCode: paymentCode(document.sale.paymentMethod),
      tedXml: ted.tedXml,
      timeZone: this.config.timeZone
    });

    const response = {
      id: externalId,
      externalId,
      status: 'processing',
      folio: String(reservation.folio),
      xml,
      pdfUrl: '',
      sii: { submitted: false, trackId: '', accepted: false },
      development: this.config.mode === 'development',
      fiscalStage: 'ted_signed',
      warning: 'Folio reservado y TED firmado con CAF. El DTE aún no es válido: falta firma XMLDSIG y recepción SII.',
      caf: {
        id: caf.id,
        documentType: caf.documentType,
        from: caf.from,
        to: caf.to,
        authorizedAt: caf.authorizedAt
      },
      ted: {
        timestamp: ted.timestamp,
        verified: true
      },
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
