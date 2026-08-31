import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const server = http.createServer(createApp(config));

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[solvea-fiscal] listening on :${config.port} mode=${config.mode}`);
});
