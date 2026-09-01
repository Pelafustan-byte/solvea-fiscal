import { extractPfxCredentials } from '../crypto/pfx.js';
import { validateIssueRequest, paymentCode } from '../domain/tax-document.js';
import { SiiAuthClient } from '../sii/auth-client.js';
import { SiiBoletaClient } from '../sii/boleta-client.js';
import { SiiBoletaLookupClient } from '../sii/boleta-lookup-client.js';
import { configuredCaf } from './issue-service.js';
import { buildUnsignedEnvioBoletaSet, signEnvioBoleta } from '../sii/envio-boleta.js';
import { buildTed } from '../sii/ted.js';
import { signDteXml } from '../sii/xml-signature.js';
import { buildUnsignedBoletaDraft } from '../sii/unsigned-boleta.js';
import { CERTIFICATION_CASES, certificationCaseRequest } from '../sii/certification-set.js';
import { createFolioStore } from './folio-store.js';
import { createCertificationRunStore } from './certification-run-store.js';

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Whitelist estricta de lo que se persiste de un error upstream del SII en un run UNCERTAIN.
 * Nunca incluye nada de nuestra propia petición (token/cookie/PFX/CAF/RSASK/Base64/password):
 * sólo campos de la RESPUESTA del SII (status/content-type/body) más metadatos propios
 * (endpoint, timestamp). Si el error no trae `detail` (p.ej. error de red antes de respuesta),
 * devuelve null.
 */
function sanitizeUpstreamDiagnostics(detail) {
  if (!detail || typeof detail !== 'object') return null;
  return {
    httpStatus: typeof detail.httpStatus === 'number' ? detail.httpStatus : (typeof detail.status === 'number' ? detail.status : null),
    contentType: typeof detail.contentType === 'string' ? detail.contentType : '',
    bodyPreview: typeof detail.bodyPreview === 'string' ? detail.bodyPreview.slice(0, 1000) : '',
    endpoint: typeof detail.endpoint === 'string' ? detail.endpoint : '',
    timestamp: typeof detail.timestamp === 'string' ? detail.timestamp : new Date().toISOString()
  };
}

const RUN_ID_PREFIX = 'cert_';

export function certificationRunId(caf) {
  return `${RUN_ID_PREFIX}${caf.id.slice(0, 24)}`;
}

const TERMINAL_STATES = new Set(['SUBMITTING', 'SUBMITTED', 'PROCESSING', 'ACCEPTED', 'REJECTED']);

export class CertificationSubmissionService {
  #certificateCredentials;

  constructor(config, { folioStore, runStore, authClient, boletaClient, lookupClient } = {}) {
    this.config = config;
    this.folioStore = folioStore || createFolioStore(config);
    this.runStore = runStore || createCertificationRunStore(config);
    this.authClient = authClient || null;
    this.boletaClient = boletaClient || null;
    this.lookupClient = lookupClient || null;
  }

  #getAuthClient() {
    if (!this.authClient) {
      this.authClient = new SiiAuthClient({ baseUrl: this.config.sii?.authBaseUrl, timeoutMs: this.config.sii?.timeoutMs });
    }
    return this.authClient;
  }

  #getBoletaClient() {
    if (!this.boletaClient) {
      this.boletaClient = new SiiBoletaClient({ baseUrl: this.config.sii?.boletaBaseUrl, timeoutMs: this.config.sii?.timeoutMs });
    }
    return this.boletaClient;
  }

  #getLookupClient() {
    if (!this.lookupClient) {
      // El servicio "Consulta de Boleta Electrónica" vive en el servidor de recursos general
      // (apicert.sii.cl en certificación) — pangal.sii.cl está documentado como exclusivo para
      // el envío, no para esta consulta. Ver src/sii/boleta-lookup-client.js.
      this.lookupClient = new SiiBoletaLookupClient({ baseUrl: this.config.sii?.authBaseUrl, timeoutMs: this.config.sii?.timeoutMs });
    }
    return this.lookupClient;
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

  #assertSafetyLockOpen() {
    if (this.config.mode !== 'certification') {
      throw httpError(409, 'El envío del set de certificación sólo está habilitado con SOLVEA_FISCAL_MODE=certification.');
    }
    if (!this.config.sii?.networkEnabled) {
      throw httpError(503, 'SII_NETWORK_ENABLED=false: no se puede enviar el set al SII.');
    }
    if (!this.config.sii?.certificationSubmissionEnabled) {
      throw httpError(423, 'Envío bloqueado: SII_CERTIFICATION_SUBMISSION_ENABLED=false. No se reservó ningún folio.');
    }
  }

  async getRun(runId) {
    return this.runStore.get(runId);
  }

  /**
   * Reserva atómicamente (idempotente por runId) los N folios contiguos del CAF 39 y arma el
   * mapping CASO-i -> folio. NO firma ni envía nada. Requiere el safety lock abierto porque
   * SÍ consume folios reales del CAF.
   */
  async reserveSet() {
    this.#assertSafetyLockOpen();
    const caf = configuredCaf(this.config, 39);
    if (!caf) throw httpError(503, 'CAF 39 no configurado.');
    const runId = certificationRunId(caf);

    const existing = await this.runStore.get(runId);
    if (existing) return existing;

    const batch = await this.folioStore.reserveBatch({ caf, count: CERTIFICATION_CASES.length, runId });
    const mapping = CERTIFICATION_CASES.map((definition, index) => ({ caso: definition.caso, folio: batch.folios[index] }));
    const run = {
      runId,
      cafId: caf.id,
      folioFrom: batch.from,
      folioTo: batch.to,
      mapping,
      status: 'RESERVED',
      createdAt: new Date().toISOString(),
      submissionAt: null,
      trackId: null,
      siiResponse: null,
      error: null
    };
    await this.runStore.put(runId, run);
    return run;
  }

  /**
   * Orquesta el envío real: preflight -> reserva -> genera y firma los 5 DTE -> arma UN
   * EnvioBOLETA con los 5 -> firma el SetDTE -> autentica -> UN solo upload -> persiste Track ID.
   * Si el resultado queda incierto (falla de red tras el upload), el estado persistido queda
   * UNCERTAIN y los folios NUNCA se liberan ni se reintenta el envío automáticamente.
   */
  async submit() {
    this.#assertSafetyLockOpen();

    const caf = configuredCaf(this.config, 39);
    if (!caf) throw httpError(503, 'CAF 39 no configurado.');
    const runId = certificationRunId(caf);

    const existing = await this.runStore.get(runId);
    if (existing && TERMINAL_STATES.has(existing.status)) {
      return existing;
    }
    if (existing && existing.status === 'UNCERTAIN') {
      throw httpError(409, 'La corrida anterior quedó en estado incierto (UNCERTAIN) tras un fallo de red. Consulta el estado real en el SII (POST /v1/certification/set/status) antes de reintentar el envío — no se reintenta automáticamente ni se reutilizan folios a ciegas.');
    }

    const credentials = this.#getCertificateCredentials();
    if (!credentials) throw httpError(503, 'SII_CERT_PFX_BASE64 es obligatorio para enviar el set.');
    if (!this.config.sii?.senderRut || !this.config.sii?.resolutionDate || this.config.sii?.resolutionNumber === '') {
      throw httpError(503, 'Falta SII_RUT_ENVIA / SII_FCH_RESOL / SII_NRO_RESOL para enviar el set.');
    }

    const run = existing || await this.reserveSet();
    const timestamp = new Date();

    const signedDtes = [];
    for (const { caso, folio } of run.mapping) {
      const request = certificationCaseRequest(caso);
      const document = validateIssueRequest(request);
      const ted = buildTed({ document, issuer: this.config.issuer, caf, folio, timestamp, timeZone: this.config.timeZone });
      const preparedXml = buildUnsignedBoletaDraft({
        document, issuer: this.config.issuer, provisionalFolio: folio,
        paymentMethodCode: paymentCode(document.sale.paymentMethod), tedXml: ted.tedXml,
        signatureTimestamp: timestamp, timeZone: this.config.timeZone
      });
      const signed = signDteXml({ xml: preparedXml, credentials });
      signedDtes.push(signed.xml);
    }

    const setId = `SetCertificacion_${caf.rut.replace(/[^0-9Kk]/g, '')}_${run.folioFrom}_${run.folioTo}`;
    const unsignedEnvelope = buildUnsignedEnvioBoletaSet({
      dteXmlList: signedDtes,
      issuerRut: this.config.issuer.rut,
      senderRut: this.config.sii.senderRut,
      siiReceiverRut: this.config.sii.receiverRut,
      resolutionDate: this.config.sii.resolutionDate,
      resolutionNumber: this.config.sii.resolutionNumber,
      setId,
      timestamp,
      timeZone: this.config.timeZone
    });
    const envelope = signEnvioBoleta({ xml: unsignedEnvelope, credentials, setId });

    const submitting = { ...run, status: 'SUBMITTING', setId, submissionAt: new Date().toISOString() };
    await this.runStore.put(runId, submitting);

    try {
      const authentication = await this.#getAuthClient().authenticate(credentials);
      const submitted = await this.#getBoletaClient().submit({
        token: authentication.token,
        senderRut: this.config.sii.senderRut,
        companyRut: this.config.issuer.rut,
        xml: envelope.xml,
        filename: `set-certificacion-${run.folioFrom}-${run.folioTo}.xml`
      });
      const finalRun = {
        ...submitting,
        status: 'SUBMITTED',
        trackId: submitted.trackId,
        siiResponse: { estado: submitted.estado, receivedAt: submitted.receivedAt, file: submitted.file }
      };
      await this.runStore.put(runId, finalRun);
      return finalRun;
    } catch (error) {
      const uncertainRun = {
        ...submitting,
        status: 'UNCERTAIN',
        error: error.message,
        upstreamDiagnostics: sanitizeUpstreamDiagnostics(error.detail)
      };
      await this.runStore.put(runId, uncertainRun);
      throw httpError(502, `Envío del set quedó en estado incierto (no se reintenta automáticamente): ${error.message}`);
    }
  }

  /**
   * Consulta el estado real en el SII para el Track ID persistido de la corrida. No modifica
   * folios. Idempotente: puede llamarse cuantas veces se quiera.
   */
  async checkStatus() {
    const caf = configuredCaf(this.config, 39);
    if (!caf) throw httpError(503, 'CAF 39 no configurado.');
    const runId = certificationRunId(caf);
    const run = await this.runStore.get(runId);
    if (!run) throw httpError(404, 'No existe una corrida de certificación para este CAF.');
    if (!run.trackId) return run;
    if (!this.config.sii?.networkEnabled) throw httpError(503, 'SII_NETWORK_ENABLED=false: no se puede consultar el estado.');

    const credentials = this.#getCertificateCredentials();
    if (!credentials) throw httpError(503, 'Certificado no configurado.');
    const authentication = await this.#getAuthClient().authenticate(credentials);
    const status = await this.#getBoletaClient().getSubmissionStatus({
      token: authentication.token,
      companyRut: this.config.issuer.rut,
      trackId: run.trackId
    });

    const nextStatus = status.accepted ? 'ACCEPTED' : status.rejected ? 'REJECTED' : 'PROCESSING';
    const updated = {
      ...run,
      status: nextStatus,
      siiResponse: {
        ...run.siiResponse,
        estado: status.estado,
        glosa: status.glosa,
        informados: status.informados,
        aceptados: status.aceptados,
        rechazados: status.rechazados,
        reparos: status.reparos,
        checkedAt: new Date().toISOString()
      }
    };
    await this.runStore.put(runId, updated);
    return updated;
  }

  /**
   * Consulta al SII (servicio oficial "Consulta de Boleta Electrónica" por folio) el estado
   * real de un conjunto de folios del CAF 39 activo, SIN reservar folios ni modificar
   * folio-state. Si existe una corrida persistida usa su mapping real; si no, usa el mapping
   * preview (folios que se usarían si se emitiera ahora). No requiere el safety lock: es una
   * operación de sólo lectura hacia el SII.
   */
  async checkFolios({ folios } = {}) {
    const caf = configuredCaf(this.config, 39);
    if (!caf) throw httpError(503, 'CAF 39 no configurado.');
    if (!this.config.sii?.networkEnabled) throw httpError(503, 'SII_NETWORK_ENABLED=false: no se puede consultar folios en el SII.');

    const credentials = this.#getCertificateCredentials();
    if (!credentials) throw httpError(503, 'Certificado no configurado.');

    const runId = certificationRunId(caf);
    const run = await this.runStore.get(runId);
    const targetFolios = Array.isArray(folios) && folios.length
      ? folios
      : (run?.mapping ? run.mapping.map((m) => m.folio) : CERTIFICATION_CASES.map((_, i) => caf.from + i));

    const authentication = await this.#getAuthClient().authenticate(credentials);
    const results = await this.#getLookupClient().checkDocuments({
      token: authentication.token,
      issuerRut: this.config.issuer.rut,
      documentType: 39,
      folios: targetFolios
    });
    return { source: run?.mapping ? 'run' : 'preview', results };
  }
}
