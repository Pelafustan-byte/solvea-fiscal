import { extractPfxCredentials } from '../crypto/pfx.js';
import { SiiAuthClient } from '../sii/auth-client.js';

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isCertificationEndpoint(url, hostname) {
  try {
    return new URL(url).hostname === hostname;
  } catch {
    return false;
  }
}

export class SandboxService {
  #credentials;

  constructor(config, { authClient, credentials } = {}) {
    this.config = config;
    this.authClient = authClient || null;
    this.#credentials = credentials;
  }

  #getCredentials() {
    if (this.#credentials !== undefined) return this.#credentials;
    if (!this.config.credentials?.certificatePfxBase64) throw httpError(503, 'Falta SII_CERT_PFX_BASE64 para probar autenticación.');
    this.#credentials = extractPfxCredentials({
      pfxBase64: this.config.credentials.certificatePfxBase64,
      password: this.config.credentials.certificatePassword,
      requireCurrent: true
    });
    return this.#credentials;
  }

  #assertCertificationOnly() {
    if (this.config.mode !== 'certification') throw httpError(409, 'El probe sandbox sólo está habilitado con SOLVEA_FISCAL_MODE=certification.');
    if (!this.config.sii?.networkEnabled) throw httpError(503, 'Active SII_NETWORK_ENABLED=true para ejecutar el probe sandbox.');
    if (!isCertificationEndpoint(this.config.sii?.authBaseUrl, 'apicert.sii.cl')) {
      throw httpError(409, 'El probe sandbox exige el endpoint oficial apicert.sii.cl y nunca usa producción.');
    }
    if (!isCertificationEndpoint(this.config.sii?.boletaBaseUrl, 'pangal.sii.cl')) {
      throw httpError(409, 'El probe sandbox exige el endpoint oficial pangal.sii.cl y nunca usa producción.');
    }
  }

  async probe() {
    this.#assertCertificationOnly();
    const credentials = this.#getCredentials();
    if (!this.config.issuer?.rut) throw httpError(503, 'Falta SII_RUT_EMISOR.');
    if (!this.authClient) {
      this.authClient = new SiiAuthClient({
        baseUrl: this.config.sii.authBaseUrl,
        timeoutMs: this.config.sii.timeoutMs
      });
    }
    const authentication = await this.authClient.authenticate(credentials);
    return {
      ok: true,
      environment: 'certification',
      network: true,
      issuerRut: this.config.issuer.rut,
      authBaseUrl: this.config.sii.authBaseUrl,
      boletaBaseUrl: this.config.sii.boletaBaseUrl,
      certificate: {
        fingerprint256: credentials.fingerprint256,
        validFrom: credentials.validFrom,
        validTo: credentials.validTo
      },
      authentication: {
        seedObtained: Boolean(authentication.seed),
        signedSeedVerified: Boolean(authentication.signedSeedVerified),
        tokenObtained: Boolean(authentication.token),
        obtainedAt: authentication.obtainedAt
      },
      safe: {
        tokenReturned: false,
        folioConsumed: false,
        documentSubmitted: false
      }
    };
  }
}
