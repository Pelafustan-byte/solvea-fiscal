import { extractPfxCredentials } from '../crypto/pfx.js';
import { SiiAuthClient } from '../sii/auth-client.js';
import { SiiBoletaClient } from '../sii/boleta-client.js';
import { createSubmissionStore } from './submission-store.js';

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanKey(value) {
  const key = String(value || '').trim();
  if (!key || key.length > 180) throw httpError(422, 'idempotencyKey inválida.');
  return key;
}

export class StatusService {
  #credentials;

  constructor(config, { submissionStore, authClient, boletaClient } = {}) {
    this.config = config;
    this.submissionStore = submissionStore || createSubmissionStore(config);
    this.authClient = authClient || null;
    this.boletaClient = boletaClient || null;
  }

  #getCredentials() {
    if (this.#credentials !== undefined) return this.#credentials;
    if (!this.config.credentials?.certificatePfxBase64) throw httpError(503, 'Falta certificado digital para consultar estado SII.');
    this.#credentials = extractPfxCredentials({
      pfxBase64: this.config.credentials.certificatePfxBase64,
      password: this.config.credentials.certificatePassword,
      requireCurrent: true
    });
    return this.#credentials;
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

  async refresh(input = {}) {
    const idempotencyKey = cleanKey(input.idempotencyKey);
    const persisted = await this.submissionStore.get(idempotencyKey);
    if (!persisted) throw httpError(404, 'No existe un envío fiscal asociado a esa idempotencyKey.');

    if (!persisted.trackId) {
      return {
        ...(persisted.response || {}),
        statusCheck: {
          refreshed: false,
          reason: persisted.state === 'uncertain' ? 'submission_uncertain_without_track_id' : 'track_id_not_available',
          checkedAt: new Date().toISOString()
        }
      };
    }

    if (!this.config.sii?.networkEnabled) throw httpError(503, 'La red SII está deshabilitada. Active SII_NETWORK_ENABLED para refrescar el Track ID.');

    const credentials = this.#getCredentials();
    const authentication = await this.#getAuthClient().authenticate(credentials);
    const status = await this.#getBoletaClient().getSubmissionStatus({
      token: authentication.token,
      companyRut: this.config.issuer.rut,
      trackId: persisted.trackId
    });

    const previous = persisted.response || {};
    const fiscalStage = status.accepted ? 'sii_accepted' : status.rejected ? 'sii_rejected' : 'sii_processing';
    const responseStatus = status.accepted ? 'issued' : status.rejected ? 'rejected' : 'processing';
    const warning = status.accepted
      ? 'Boleta aceptada por el SII en ambiente configurado.'
      : status.rejected
        ? `El SII rechazó el envío${status.glosa ? `: ${status.glosa}` : '.'}`
        : `El SII aún procesa el envío${status.estado ? ` (${status.estado})` : ''}.`;

    const response = {
      ...previous,
      status: responseStatus,
      fiscalStage,
      warning,
      sii: {
        ...(previous.sii || {}),
        submitted: true,
        trackId: status.trackId,
        accepted: status.accepted,
        rejected: status.rejected,
        final: status.final,
        estado: status.estado,
        glosa: status.glosa,
        informados: status.informados,
        aceptados: status.aceptados,
        rechazados: status.rechazados,
        reparos: status.reparos,
        checkedAt: new Date().toISOString()
      },
      statusCheck: {
        refreshed: true,
        checkedAt: new Date().toISOString()
      }
    };

    await this.submissionStore.put(idempotencyKey, {
      ...persisted,
      state: status.accepted ? 'accepted' : status.rejected ? 'rejected' : 'processing',
      response,
      lastSiiStatus: {
        estado: status.estado,
        glosa: status.glosa,
        accepted: status.accepted,
        rejected: status.rejected,
        checkedAt: response.sii.checkedAt
      },
      updatedAt: new Date().toISOString()
    });

    return response;
  }
}
