import { authBaseUrlForMode } from './sii/auth-client.js';
import { boletaBaseUrlForMode } from './sii/boleta-client.js';

const text = (value) => String(value ?? '').trim();
const bool = (value, fallback = false) => value == null || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());

function hostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

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
      certificationSubmissionEnabled: bool(env.SII_CERTIFICATION_SUBMISSION_ENABLED, false),
      authBaseUrl: text(env.SII_AUTH_BASE_URL) || authBaseUrlForMode(mode),
      boletaBaseUrl: text(env.SII_BOLETA_BASE_URL) || boletaBaseUrlForMode(mode),
      timeoutMs: Math.max(1000, Number(env.SII_HTTP_TIMEOUT_MS || 15000)),
      senderRut: text(env.SII_RUT_ENVIA),
      receiverRut: text(env.SII_RUT_RECEPTOR || '60803000-K'),
      resolutionDate: text(env.SII_FCH_RESOL),
      resolutionNumber: text(env.SII_NRO_RESOL)
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
      caf41Base64: text(env.SII_CAF_41_XML_BASE64),
      caf33Base64: text(env.SII_CAF_33_XML_BASE64),
      caf34Base64: text(env.SII_CAF_34_XML_BASE64)
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

  const submissionMissing = [];
  if (!config.sii?.senderRut) submissionMissing.push('sii.senderRut');
  if (!config.sii?.resolutionDate) submissionMissing.push('sii.resolutionDate');
  if (config.sii?.resolutionNumber === '') submissionMissing.push('sii.resolutionNumber');

  const configurationReady = issuerMissing.length === 0 && credentialMissing.length === 0;
  const submissionReady = configurationReady && submissionMissing.length === 0;
  const sandboxEndpointsSafe = hostname(config.sii?.authBaseUrl) === 'apicert.sii.cl'
    && hostname(config.sii?.boletaBaseUrl) === 'pangal.sii.cl';
  const sandboxReady = config.mode === 'certification'
    && Boolean(config.sii?.networkEnabled)
    && submissionReady
    && sandboxEndpointsSafe;

  return {
    mode: config.mode,
    productionReady: false,
    configurationReady,
    submissionReady,
    sandboxReady,
    sandboxEndpointsSafe,
    statePersistence: config.stateDir ? 'file' : 'memory',
    siiNetworkEnabled: Boolean(config.sii?.networkEnabled),
    certificationSubmissionEnabled: Boolean(config.sii?.certificationSubmissionEnabled),
    siiAuthBaseUrl: config.sii?.authBaseUrl || '',
    siiBoletaBaseUrl: config.sii?.boletaBaseUrl || '',
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
      envioBoletaEnvelope: true,
      envioBoletaSignature: true,
      siiSubmissionClient: true,
      siiStatusTrackingClient: true,
      siiStatusRefresh: true,
      sandboxProbe: true,
      siiLiveFlow: Boolean(config.sii?.networkEnabled && submissionReady)
    },
    rcof: {
      requiredForCertification: true,
      operationalObligationEliminated: true,
      note: 'La Resolución Ex. SII N°53/2022 eliminó el envío PERIÓDICO (diario) del RCOF/Resumen de Ventas Diarias una vez habilitado como emisor — el Registro de Ventas se alimenta automáticamente de las boletas recibidas por el SII. Eso NO aplica al proceso de certificación: el instructivo vigente de certificación de Boleta Electrónica sigue exigiendo un RCOF (formato oficial ConsumoFolios, ConsumoFolio_v10.xsd) como parte del set de pruebas. Ver pestaña Certificación / RCOF.'
    },
    documentTypesAvailable: {
      boleta_afecta: Boolean(config.credentials.caf39Base64),
      boleta_exenta: Boolean(config.credentials.caf41Base64),
      factura_afecta: Boolean(config.credentials.caf33Base64),
      factura_exenta: Boolean(config.credentials.caf34Base64)
    },
    missing: [...issuerMissing, ...credentialMissing, ...submissionMissing],
    blockers: [
      'verificación de la firma del SII sobre el CAF con llave pública oficial',
      ...(config.sii?.networkEnabled ? [] : ['habilitar red SII explícitamente para pruebas de certificación']),
      ...(config.mode === 'certification' && !sandboxEndpointsSafe ? ['usar endpoints oficiales apicert/pangal para sandbox'] : []),
      'worker automático de conciliación/reintentos controlados',
      'almacenamiento transaccional multi-instancia para producción',
      ...(config.sii?.certificationSubmissionEnabled ? [] : ['SII_CERTIFICATION_SUBMISSION_ENABLED=false: reserva de folios y envío de DTE bloqueados']),
      'certificación del contribuyente ante el SII',
      'RCOF de certificación (ConsumoFolios) pendiente de envío al SII'
    ]
  };
}
