import { createHash } from 'node:crypto';
import { extractPfxCredentials } from '../crypto/pfx.js';
import { validateIssueRequest, paymentCode } from '../domain/tax-document.js';
import { SiiAuthClient } from '../sii/auth-client.js';
import { SiiBoletaClient } from '../sii/boleta-client.js';
import { assertCafCompatible, decodeCafBase64, parseCaf } from '../sii/caf.js';
import { buildUnsignedEnvioBoleta, signEnvioBoleta } from '../sii/envio-boleta.js';
import { buildTed } from '../sii/ted.js';
import { signDteXml } from '../sii/xml-signature.js';
import { buildUnsignedBoletaDraft } from '../sii/unsigned-boleta.js';
import { createFolioStore } from './folio-store.js';
import { createSubmissionStore } from './submission-store.js';

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

function assertSubmissionConfigured(config) {
  const missing = [];
  if (!config.sii?.senderRut) missing.push('SII_RUT_ENVIA');
  if (!config.sii?.resolutionDate) missing.push('SII_FCH_RESOL');
  if (config.sii?.resolutionNumber === '') missing.push('SII_NRO_RESOL');
  if (missing.length) throw httpError(503, `Falta configuración para envío SII: ${missing.join(', ')}.`);
}

export class IssueService {
  #records = new Map();
  #certificateCredentials;

  constructor(config, { folioStore, submissionStore, authClient, boletaClient } = {}) {
    this.config = config;
    this.folioStore = folioStore || createFolioStore(config);
    this.submissionStore = submissionStore || createSubmissionStore(config);
    this.authClient = authClient || new SiiAuthClient({ baseUrl: config.sii?.authBaseUrl, timeoutMs: config.sii?.timeoutMs });
    this.boletaClient = boletaClient || new SiiBoletaClient({ baseUrl: config.sii?.boletaBaseUrl, timeoutMs: config.sii?.timeoutMs });
  }

  #getCertificateCredentials() {
    if (this.#certificateCredentials !== undefined) return this.#certificateCredentials;
    if (!this.config.credentials?.certificatePfxBase64) {
      this.#certificateCredentials = null;
      return null;
    }
    this.#certificateCredentials = extractPfxCredentials({
      pfxBase64: this.config.credentials.certificatePfxBase64,
      password: this.config.credentials.certificatePassword,
      requireCurrent: true
    });
    return this.#certificateCredentials;
  }

  async issue(input) {
    const document = validateIssueRequest(input);
    const payloadHash = fingerprint(document);
    const previous = this.#records.get(document.idempotencyKey);
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw httpError(409, 'La idempotencyKey ya fue utilizada con otro contenido.');
      return previous.response;
    }

    const persisted = await this.submissionStore.get(document.idempotencyKey);
    if (persisted) {
      if (persisted.payloadHash !== payloadHash) throw httpError(409, 'La idempotencyKey persistida corresponde a otro contenido.');
      if (persisted.response) {
        this.#records.set(document.idempotencyKey, { payloadHash, response: persisted.response });
        return persisted.response;
      }
    }

    if (this.config.mode === 'production') {
      throw httpError(503, 'Producción SII permanece bloqueada hasta completar certificación y endurecimiento multi-instancia.');
    }

    const caf = configuredCaf(this.config, document.documentCode);
    const externalId = externalIdFor(document.idempotencyKey);
    if (!caf) {
      if (this.config.mode !== 'development') throw httpError(503, `Falta CAF de certificación para TipoDTE ${document.documentCode}.`);
      const xml = buildUnsignedBoletaDraft({ document, issuer: this.config.issuer, paymentMethodCode: paymentCode(document.sale.paymentMethod), timeZone: this.config.timeZone });
      const response = {
        id: externalId, externalId, status: 'processing', folio: '', xml, pdfUrl: '',
        sii: { submitted: false, trackId: '', accepted: false }, development: true,
        fiscalStage: 'draft_without_caf',
        warning: 'Borrador sin validez tributaria. No contiene CAF, TED, firma XML ni recepción SII.',
        document: { type: document.documentType, code: document.documentCode, saleId: document.sale.id, saleNumber: document.sale.number, total: document.sale.total }
      };
      this.#records.set(document.idempotencyKey, { payloadHash, response });
      return response;
    }

    assertIssuerConfigured(this.config);
    assertCafCompatible(caf, { issuerRut: this.config.issuer.rut, documentType: document.documentCode });
    if (this.config.mode === 'certification' && !this.config.stateDir) throw httpError(503, 'SOLVEA_FISCAL_STATE_DIR es obligatorio en certificación.');

    const certificateCredentials = this.#getCertificateCredentials();
    if (this.config.mode === 'certification' && !certificateCredentials) throw httpError(503, 'SII_CERT_PFX_BASE64 es obligatorio en certificación.');

    const reservation = await this.folioStore.reserve({ caf, idempotencyKey: document.idempotencyKey, payloadHash, timestamp: new Date().toISOString() });
    const ted = buildTed({ document, issuer: this.config.issuer, caf, folio: reservation.folio, timestamp: reservation.timestamp, timeZone: this.config.timeZone });
    const preparedXml = buildUnsignedBoletaDraft({
      document, issuer: this.config.issuer, provisionalFolio: reservation.folio,
      paymentMethodCode: paymentCode(document.sale.paymentMethod), tedXml: ted.tedXml,
      signatureTimestamp: reservation.timestamp, timeZone: this.config.timeZone
    });
    const signed = certificateCredentials ? signDteXml({ xml: preparedXml, credentials: certificateCredentials }) : null;
    const dteXml = signed?.xml || preparedXml;

    const baseResponse = {
      id: externalId, externalId, status: 'processing', folio: String(reservation.folio), xml: dteXml, pdfUrl: '',
      sii: { submitted: false, trackId: '', accepted: false },
      development: this.config.mode === 'development',
      fiscalStage: signed ? 'dte_signed' : 'ted_signed',
      warning: signed ? 'DTE firmado localmente; pendiente de envío y aceptación SII.' : 'TED firmado; falta XMLDSIG y recepción SII.',
      caf: { id: caf.id, documentType: caf.documentType, from: caf.from, to: caf.to, authorizedAt: caf.authorizedAt },
      ted: { timestamp: ted.timestamp, verified: true },
      signature: signed ? {
        verified: true, documentId: signed.documentId, digestValue: signed.digestValue,
        certificateFingerprint256: certificateCredentials.fingerprint256,
        certificateValidFrom: certificateCredentials.validFrom, certificateValidTo: certificateCredentials.validTo
      } : { verified: false },
      document: { type: document.documentType, code: document.documentCode, saleId: document.sale.id, saleNumber: document.sale.number, total: document.sale.total }
    };

    if (!this.config.sii?.networkEnabled) {
      this.#records.set(document.idempotencyKey, { payloadHash, response: baseResponse });
      return baseResponse;
    }

    if (!signed || !certificateCredentials) throw httpError(503, 'No se puede enviar al SII sin DTE y certificado verificados.');
    assertSubmissionConfigured(this.config);
    const setId = `SetDocB0T${document.documentCode}_${reservation.folio}`;
    const unsignedEnvelope = buildUnsignedEnvioBoleta({
      dteXml: signed.xml,
      documentType: document.documentCode,
      issuerRut: this.config.issuer.rut,
      senderRut: this.config.sii.senderRut,
      siiReceiverRut: this.config.sii.receiverRut,
      resolutionDate: this.config.sii.resolutionDate,
      resolutionNumber: this.config.sii.resolutionNumber,
      setId,
      timestamp: reservation.timestamp,
      timeZone: this.config.timeZone
    });
    const envelope = signEnvioBoleta({ xml: unsignedEnvelope, credentials: certificateCredentials, setId });
    const provisional = {
      ...baseResponse,
      xml: envelope.xml,
      fiscalStage: 'sii_submitting',
      warning: 'Sobre firmado y marcado para envío SII. No reenviar automáticamente si el proceso se interrumpe.',
      envelope: { setId, verified: true }
    };
    await this.submissionStore.put(document.idempotencyKey, {
      payloadHash, state: 'submitting', folio: reservation.folio, setId,
      envelopeHash: createHash('sha256').update(Buffer.from(envelope.xml, 'latin1')).digest('hex'),
      response: provisional, updatedAt: new Date().toISOString()
    });

    try {
      const authentication = await this.authClient.authenticate(certificateCredentials);
      const submitted = await this.boletaClient.submit({
        token: authentication.token,
        senderRut: this.config.sii.senderRut,
        companyRut: this.config.issuer.rut,
        xml: envelope.xml,
        filename: `boleta-${document.documentCode}-${reservation.folio}.xml`
      });
      const response = {
        ...provisional,
        fiscalStage: 'sii_submitted',
        warning: 'SII recibió el envío y asignó Track ID. La aceptación tributaria aún debe confirmarse por consulta de estado.',
        sii: {
          submitted: true,
          trackId: submitted.trackId,
          accepted: false,
          estado: submitted.estado,
          receivedAt: submitted.receivedAt,
          file: submitted.file
        }
      };
      await this.submissionStore.put(document.idempotencyKey, {
        payloadHash, state: 'submitted', folio: reservation.folio, setId,
        trackId: submitted.trackId, response, updatedAt: new Date().toISOString()
      });
      this.#records.set(document.idempotencyKey, { payloadHash, response });
      return response;
    } catch (error) {
      const response = {
        ...provisional,
        fiscalStage: 'sii_submission_uncertain',
        warning: `No se confirmó el resultado del envío SII. No se reintentará automáticamente: ${error.message}`,
        sii: { submitted: false, trackId: '', accepted: false, uncertain: true }
      };
      await this.submissionStore.put(document.idempotencyKey, {
        payloadHash, state: 'uncertain', folio: reservation.folio, setId,
        response, error: error.message, updatedAt: new Date().toISOString()
      });
      this.#records.set(document.idempotencyKey, { payloadHash, response });
      return response;
    }
  }
}
