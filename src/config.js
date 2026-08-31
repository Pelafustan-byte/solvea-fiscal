const text = (value) => String(value ?? '').trim();

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
    capabilities: {
      cafParsing: true,
      cafKeyPairVerification: true,
      folioReservation: true,
      tedSigning: true,
      dteXmlSignature: false,
      siiAuthentication: false,
      siiSubmission: false,
      siiStatusTracking: false
    },
    missing: [...issuerMissing, ...credentialMissing],
    blockers: [
      'verificación de la firma del SII sobre el CAF con llave pública oficial',
      'firma XMLDSIG del DTE con certificado digital',
      'autenticación SII por semilla/token',
      'envío de boletas y seguimiento de Track ID',
      'almacenamiento transaccional multi-instancia para producción',
      'Resumen de Ventas Diarias / consumo de folios',
      'certificación del contribuyente ante el SII'
    ]
  };
}
