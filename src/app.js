import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readiness } from './config.js';
import { IssueService, configuredCaf } from './services/issue-service.js';
import { SandboxService } from './services/sandbox-service.js';
import { StatusService } from './services/status-service.js';
import { createBrandingStore } from './services/branding-store.js';
import { extractPfxCredentials } from './crypto/pfx.js';
import { prepareCertificationSet, validateCertificationSet, prepareCertificationRcof, previewFolioMapping } from './sii/certification-set.js';
import { prepareFacturaCertificationSet } from './sii/factura-certification-set.js';
import { CertificationSubmissionService, certificationRunId } from './services/certification-submission-service.js';
import { collectStorageDiagnostics, writeStorageProbe } from './lib/storage-diagnostics.js';
import { SiiAuthClient } from './sii/auth-client.js';
import { SiiBoletaLookupClient } from './sii/boleta-lookup-client.js';
import { diagnosePangalAuth } from './sii/pangal-auth-probe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const MAX_LOGO_BYTES = 400 * 1024;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) {
      const error = new Error('Payload demasiado grande.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('JSON inválido.');
    error.status = 400;
    throw error;
  }
}

function authorized(req, config) {
  if (!config.apiToken) return config.mode === 'development';
  return req.headers.authorization === `Bearer ${config.apiToken}`;
}

function html(res, status, body) {
  const payload = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store'
  });
  res.end(payload);
}

export function createApp(config) {
  const issueService = new IssueService(config);
  const statusService = new StatusService(config, { submissionStore: issueService.submissionStore });
  const sandboxService = new SandboxService(config);
  const brandingStore = createBrandingStore(config);
  const certificationSubmissionService = new CertificationSubmissionService(config);
  let lastProbe = null;

  function certificateStatus() {
    if (!config.credentials?.certificatePfxBase64) return { ok: false, error: 'SII_CERT_PFX_BASE64 no configurado.' };
    try {
      const credentials = extractPfxCredentials({
        pfxBase64: config.credentials.certificatePfxBase64,
        password: config.credentials.certificatePassword,
        requireCurrent: true
      });
      return { ok: true, validFrom: credentials.validFrom, validTo: credentials.validTo, fingerprint256: credentials.fingerprint256 };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async function currentRun() {
    let caf;
    try {
      caf = configuredCaf(config, 39);
    } catch {
      return null;
    }
    if (!caf) return null;
    return certificationSubmissionService.getRun(certificationRunId(caf));
  }

  function cafStatus(documentCode) {
    try {
      const caf = configuredCaf(config, documentCode);
      if (!caf) return { ok: false, error: `CAF ${documentCode} no configurado.` };
      return { ok: true, from: caf.from, to: caf.to, authorizedAt: caf.authorizedAt, rut: caf.rut };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  return async function app(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, service: 'solvea-fiscal', mode: config.mode });
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const page = await readFile(path.join(publicDir, 'index.html'), 'utf8');
        return html(res, 200, page);
      }

      if (req.method === 'GET' && url.pathname === '/v1/config/public') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const ready = readiness(config);
        return json(res, 200, {
          mode: config.mode,
          issuer: config.issuer,
          documentTypesAvailable: ready.documentTypesAvailable,
          siiNetworkEnabled: ready.siiNetworkEnabled,
          certificationSubmissionEnabled: ready.certificationSubmissionEnabled,
          rcof: ready.rcof
        });
      }

      if (req.method === 'GET' && url.pathname === '/v1/branding') {
        return json(res, 200, await brandingStore.get());
      }

      if (req.method === 'PUT' && url.pathname === '/v1/branding') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const body = await readJson(req);
        if (body.logo !== undefined) {
          const dataUri = String(body.logo || '');
          if (dataUri && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUri)) {
            const error = new Error('logo debe ser un data URI PNG/JPEG/WEBP en base64.');
            error.status = 422;
            throw error;
          }
          if (dataUri.length > MAX_LOGO_BYTES * 1.4) {
            const error = new Error('Logo demasiado grande (máx. ~400KB).');
            error.status = 413;
            throw error;
          }
        }
        const updated = await brandingStore.update({
          logo: body.logo, businessName: body.businessName, footerMessage: body.footerMessage,
          showRegister: body.showRegister, showSeller: body.showSeller, showQr: body.showQr
        });
        return json(res, 200, updated);
      }

      if (req.method === 'GET' && url.pathname === '/v1/readiness') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        return json(res, 200, readiness(config));
      }

      if (req.method === 'POST' && url.pathname === '/v1/sandbox/probe') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const result = await sandboxService.probe();
        lastProbe = { at: new Date().toISOString(), ok: Boolean(result?.authentication?.tokenObtained) };
        return json(res, 200, result);
      }

      if (req.method === 'POST' && url.pathname === '/v1/documents/prepare') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const body = await readJson(req);
        return json(res, 200, await issueService.prepare(body));
      }

      if (req.method === 'POST' && url.pathname === '/v1/documents/issue') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const body = await readJson(req);
        return json(res, 202, await issueService.issue(body));
      }

      if (req.method === 'POST' && url.pathname === '/v1/documents/status') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const body = await readJson(req);
        return json(res, 200, await statusService.refresh(body));
      }

      if (req.method === 'GET' && url.pathname === '/v1/certification/status') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const ready = readiness(config);
        const folios = await issueService.folioUsage(39);
        const run = await currentRun();
        return json(res, 200, {
          mode: config.mode,
          certificate: certificateStatus(),
          caf39: cafStatus(39),
          readiness: { configurationReady: ready.configurationReady, submissionReady: ready.submissionReady, sandboxReady: ready.sandboxReady },
          siiNetworkEnabled: ready.siiNetworkEnabled,
          certificationSubmissionEnabled: ready.certificationSubmissionEnabled,
          lastProbe,
          folios: folios || { used: 0, available: 0, from: 0, to: 0 },
          rcof: ready.rcof,
          run: run ? { runId: run.runId, status: run.status, folioFrom: run.folioFrom, folioTo: run.folioTo, trackId: run.trackId } : null
        });
      }

      if (req.method === 'GET' && url.pathname === '/v1/certification/set') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const cases = await prepareCertificationSet(issueService);
        let mapping = null;
        try {
          const caf = configuredCaf(config, 39);
          if (caf) mapping = previewFolioMapping(caf);
        } catch { /* CAF inválido: sin mapping preview */ }
        return json(res, 200, { cases, previewMapping: mapping });
      }

      if (req.method === 'GET' && url.pathname === '/v1/certification/factura/set') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const cases = await prepareFacturaCertificationSet(issueService);
        return json(res, 200, { cases });
      }

      if (req.method === 'POST' && url.pathname === '/v1/certification/set/validate') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const cases = await prepareCertificationSet(issueService);
        const result = await validateCertificationSet(config, cases);
        return json(res, 200, { ...result, cases });
      }

      if (req.method === 'GET' && url.pathname === '/v1/certification/rcof') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const cases = await prepareCertificationSet(issueService);
        const run = await currentRun();
        const runFolios = run && run.mapping ? run.mapping.map((m) => m.folio) : undefined;
        const rcof = prepareCertificationRcof(config, cases, { runFolios });
        return json(res, 200, rcof);
      }

      if (req.method === 'GET' && url.pathname === '/v1/certification/rcof/xml') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const cases = await prepareCertificationSet(issueService);
        const run = await currentRun();
        const runFolios = run && run.mapping ? run.mapping.map((m) => m.folio) : undefined;
        const rcof = prepareCertificationRcof(config, cases, { runFolios });
        if (!rcof.xml) return json(res, 409, { error: 'RCOF no disponible todavía.', errors: rcof.errors });
        const payload = Buffer.from(rcof.xml, 'latin1');
        res.writeHead(200, {
          'content-type': 'application/xml; charset=ISO-8859-1',
          'content-length': payload.length,
          'content-disposition': `attachment; filename="ConsumoFolios-${rcof.folios?.from || ''}-${rcof.folios?.to || ''}.xml"`,
          'cache-control': 'no-store'
        });
        return res.end(payload);
      }

      if (req.method === 'GET' && url.pathname === '/v1/certification/run') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const run = await currentRun();
        return json(res, 200, { run });
      }

      if (req.method === 'POST' && url.pathname === '/v1/certification/set/submit') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const run = await certificationSubmissionService.submit();
        return json(res, 202, { run });
      }

      if (req.method === 'POST' && url.pathname === '/v1/certification/set/status') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const run = await certificationSubmissionService.checkStatus();
        return json(res, 200, { run });
      }

      if (req.method === 'POST' && url.pathname === '/v1/certification/folios/check') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const body = await readJson(req).catch(() => ({}));
        const result = await certificationSubmissionService.checkFolios({ folios: body.folios, receptorRut: body.receptorRut, fechaEmision: body.fechaEmision });
        return json(res, 200, result);
      }

      if (req.method === 'POST' && url.pathname === '/v1/certification/arm') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const arm = await certificationSubmissionService.arm();
        return json(res, 200, { arm });
      }

      if (req.method === 'GET' && url.pathname === '/v1/certification/arm') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        const arm = await certificationSubmissionService.getArmStatus();
        return json(res, 200, { arm });
      }

      if (req.method === 'GET' && url.pathname === '/v1/certification/diagnostics/storage') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        return json(res, 200, await collectStorageDiagnostics(config.stateDir));
      }

      if (req.method === 'POST' && url.pathname === '/v1/certification/diagnostics/storage-probe') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        if (!config.stateDir) throw Object.assign(new Error('SOLVEA_FISCAL_STATE_DIR no configurado.'), { status: 503 });
        return json(res, 200, await writeStorageProbe(config.stateDir));
      }

      if (req.method === 'POST' && url.pathname === '/v1/certification/diagnostics/pangal-auth') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        if (!config.credentials?.certificatePfxBase64) throw Object.assign(new Error('Certificado no configurado.'), { status: 503 });
        const credentials = extractPfxCredentials({
          pfxBase64: config.credentials.certificatePfxBase64,
          password: config.credentials.certificatePassword,
          requireCurrent: true
        });
        const authClient = new SiiAuthClient({ baseUrl: config.sii?.authBaseUrl, timeoutMs: config.sii?.timeoutMs });
        const authentication = await authClient.authenticate(credentials);

        const caf = configuredCaf(config, 39);
        let apicertCheck = null;
        if (caf) {
          const lookupClient = new SiiBoletaLookupClient({ baseUrl: config.sii?.authBaseUrl, timeoutMs: config.sii?.timeoutMs });
          apicertCheck = await lookupClient.checkDocument({
            token: authentication.token, issuerRut: config.issuer.rut, documentType: 39, folio: caf.from,
            receptorRut: '66666666-6', monto: 1, fechaEmision: '01-01-2026'
          });
        }

        const pangalDiagnostic = await diagnosePangalAuth({
          pangalBaseUrl: config.sii?.boletaBaseUrl,
          token: authentication.token,
          senderRut: config.sii?.senderRut,
          companyRut: config.issuer.rut,
          cert: credentials.certificatePem,
          key: credentials.privateKeyPem
        });

        return json(res, 200, {
          openApiHosts: { auth: config.sii?.authBaseUrl || '', upload: config.sii?.boletaBaseUrl || '' },
          apicertTokenCheck: apicertCheck ? { httpStatus: apicertCheck.httpStatus, result: apicertCheck.result, codigo: apicertCheck.codigo, reason: apicertCheck.reason || null } : null,
          ...pangalDiagnostic
        });
      }

      return json(res, 404, { error: 'Ruta no encontrada.' });
    } catch (error) {
      return json(res, Number(error.status) || 500, {
        error: error.message || 'Error interno.',
        code: Number(error.status) || 500
      });
    }
  };
}
