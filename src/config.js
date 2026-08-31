import { authBaseUrlForMode } from './sii/auth-client.js';

const text = (value) => String(value ?? '').trim();
const bool = (value, fallback = false) => value == null || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());

export function loadConfig(env = process.env) {
  const mode = text(env.SOLVEA_FISCAL_MODE || 'development').toLowerCase();
  if (!['development', 'certification', 'production'].includes(mode)) {
    throw new Error('SOLVEA_FISCAL_MODE debe ser development, certification o production.');
  }

  return {
    port: Number(env.PORT || 8787),
    mode,
    apiToken: text(env.SOLVEA_FISCAL_API_TOKEN),
    stateDir: text(env.SOLVEA_FISCAL_STATE_DIR),
    timeZone: text(env.SII_TIME_ZONE || 'America/Santiago'),
    sii: {
      networkEnabled: bool(env.SII_NETWORK_ENABLED, false),
      authBaseUrl: text(env.SII_AUTH_BASE_URL) || authBaseUrlForMode(mode),
      timeoutMs: Math.max(1000, Number(env.SII_HTTP_TIMEOUT_MS || 15000))
    },
    issuer: {
      rut: text(env.SII_RUT_EMISOR),
      legalName: text(env.SII_RAZON_SOCIAL),
      activity: text(env.SII_GIRO),
      address: text(env.SII_DIRECCION_ORIGEN),
      commune: text(env.SII_COMUNA_ORIGEN),
      city: text(env.SII_CIUDAD_ORIGEN),
      branchCode: text(env.SII_CODIGO_SUCURSAL)
    },
    credentials: {
      certificatePfxBase64: text(env.SII_CERT_PFX_BASE64),
      certificatePassword: text(env.SII_CERT_PASSWORD),
      caf39Base64: text(env.SII_CAF_39_XML_BASE64),
      caf41Base64: text(env.SII_CAF_41_XML_BASE64)
    }
  };
}

export function readiness(config) {
  const issuerMissing = Object.entries(config.issuer)
    .filter(([key, value]) => key !== 'branchCode' && !value)
    .map(([key]) => `issuer.${key}`);

  const credentialMissing = [];
  if (!config.credentials.certificatePfxBase64) credentialMissing.push('certificate');
  if (!config.credentials.caf39Base64) credentialMissing.push('caf39');
  if (config.mode === 'certification' && !config.stateDir) credentialMissing.push('stateDir');

  const configurationReady = issuerMissing.length === 0 && credentialMissing.length === 0;
  return {
    mode: config.mode,
    productionReady: false,
    configurationReady,
    statePersistence: config.stateDir ? 'file' : 'memory',
    siiNetworkEnabled: Boolean(config.sii?.networkEnabled),
    siiAuthBaseUrl: config.sii?.authBaseUrl || '',
    capabilities: {
      cafParsing: true,
      cafKeyPairVerification: true,
      folioReservation: true,
      tedSigning: true,
      pfxExtraction: true,
      certificateValidityCheck: true,
      dteXmlSignature: true,
      dteXmlSignatureVerification: true,
      siiSeedSignature: true,
      siiAuthenticationClient: true,
      siiAuthenticationLive: Boolean(config.sii?.networkEnabled && config.credentials.certificatePfxBase64),
      siiSubmission: false,
      siiStatusTracking: false
    },
    missing: [...issuerMissing, ...credentialMissing],
    blockers: [
      'verificación de la firma del SII sobre el CAF con llave pública oficial',
      ...(config.sii?.networkEnabled ? [] : ['habilitar red SII explícitamente para pruebas de certificación']),
      'envío de boletas y seguimiento de Track ID',
      'almacenamiento transaccional multi-instancia para producción',
      'Resumen de Ventas Diarias / consumo de folios',
      'certificación del contribuyente ante el SII'
    ]
  };
}
