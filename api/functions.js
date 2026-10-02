import { app } from '@azure/functions';
import { config } from './server/config.js';
import { createStore } from './server/store.js';
import { createApp } from './server/app.js';
// Deployment copies shared server/ into the Function app package.
let ready;
function application() {
  return ready ||= (async () => { const cfg = config(); return createApp(cfg, await createStore(cfg)); })();
}
app.http('player-api', {
  route: '{*path}', methods: ['GET', 'POST', 'OPTIONS'], authLevel: 'anonymous',
  handler: async request => {
    const webRequest = new Request(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text() });
    const response = await (await application()).handle(webRequest, { clientIp: (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim() });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) };
  },
});
app.timer('queue-driver', { schedule: '*/15 * * * * *', runOnStartup: false, useMonitor: false, handler: async (_timer, context) => {
  try { await (await application()).tick(); } catch (error) { context.warn('Queue worker:', error.message); }
} });
app.timer('addon-driver', { schedule: '0 * * * * *', runOnStartup: false, handler: async (_timer, context) => {
  try { await (await application()).generateAddons(); } catch (error) { context.warn('Add-on worker:', error.message); }
} });
