import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { createStore } from './store.js';
import { createApp } from './app.js';

const cfg = config(), store = await createStore(cfg), app = createApp(cfg, store);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const dist = path.resolve('dist');
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Request too large.' })); return; }
        chunks.push(chunk);
      }
      const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const response = await app.handle(request, { clientIp: req.socket.remoteAddress });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const file = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (file !== dist && !file.startsWith(dist + path.sep)) { res.writeHead(403); res.end(); return; }
    let content, extension = path.extname(file);
    try { content = await readFile(file); }
    catch {
      if (extension && extension !== '.html') { res.writeHead(404); res.end(); return; }
      content = await readFile(path.join(dist, 'index.html')); extension = '.html';
    }
    res.writeHead(200, { 'Content-Type': mime[extension] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); res.end(content);
  } catch { res.writeHead(500); res.end('Build the frontend with npm run build, or use npm run dev.'); }
});
server.listen(cfg.port, '127.0.0.1', () => console.log(`vibeQ API: http://127.0.0.1:${cfg.port} · ${cfg.storage} storage`));
async function queueLoop() {
  try { await app.tick(); } catch (error) { console.warn('Queue worker:', error.message); }
  queueTimer = setTimeout(queueLoop, 15000);
}
async function addonLoop() {
  try { await app.generateAddons(); } catch (error) { console.warn('Add-on worker:', error.message); }
  addonTimer = setTimeout(addonLoop, 60000);
}
let queueTimer, addonTimer;
queueLoop(); addonLoop();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearTimeout(queueTimer); clearTimeout(addonTimer);
  server.close(() => { store.close(); process.exit(0); });
});
