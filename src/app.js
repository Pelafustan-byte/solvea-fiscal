import { readiness } from './config.js';
import { IssueService } from './services/issue-service.js';
import { SandboxService } from './services/sandbox-service.js';
import { StatusService } from './services/status-service.js';

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

export function createApp(config) {
  const issueService = new IssueService(config);
  const statusService = new StatusService(config, { submissionStore: issueService.submissionStore });
  const sandboxService = new SandboxService(config);

  return async function app(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, service: 'solvea-fiscal', mode: config.mode });
      }

      if (req.method === 'GET' && url.pathname === '/v1/readiness') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        return json(res, 200, readiness(config));
      }

      if (req.method === 'POST' && url.pathname === '/v1/sandbox/probe') {
        if (!authorized(req, config)) return json(res, 401, { error: 'No autorizado.' });
        return json(res, 200, await sandboxService.probe());
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

      return json(res, 404, { error: 'Ruta no encontrada.' });
    } catch (error) {
      return json(res, Number(error.status) || 500, {
        error: error.message || 'Error interno.',
        code: Number(error.status) || 500
      });
    }
  };
}
