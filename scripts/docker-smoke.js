// Uses only disposable containers, generated credentials and a new test volume.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2] || 'vibeq:local';
const name = `vibeq-test-${randomUUID()}`, volume = `${name}-data`;
const password = randomUUID(), secret = randomUUID();
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 300000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result.stdout.trim();
}
function execute(source) {
  // Base64 avoids shell quoting differences between Windows and Linux.
  return docker('exec', name, 'node', '--input-type=module', '-e',
    `await import('data:text/javascript;base64,${Buffer.from(source).toString('base64')}')`);
}
let base;
async function ready() {
  const address = docker('port', name, '3001/tcp').split('\n')[0].trim();
  base = `http://${address}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await delay(1000);
  }
  throw new Error('Container failed readiness: ' + docker('logs', name));
}
async function api(path, data, token) {
  const response = await fetch(`${base}/api${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5000),
  });
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
function start() {
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::3001', '-v', `${volume}:/app/data`,
    '-e', `HOST_PASSWORD=${password}`, '-e', `SESSION_SECRET=${secret}`,
    '-e', 'SPOTIFY_CLIENT_ID=test-client', '-e', 'SPOTIFY_CLIENT_SECRET=test-secret',
    '-e', 'APP_ORIGIN=http://127.0.0.1:3001', '-e', 'SPOTIFY_REDIRECT_URI=http://127.0.0.1:3001/api/spotify/callback', image);
}
function stop() {
  docker('stop', '--time', '240', name);
  assert.equal(docker('inspect', '--format', '{{.State.ExitCode}}', name), '0');
  assert.match(docker('logs', name), /database closed/);
}
try {
  assert.equal(docker('info', '--format', '{{.OSType}}'), 'linux');
  console.log('Starting disposable container and data volume.');
  docker('volume', 'create', volume);
  start(); await ready();
  assert.equal(execute('console.log(process.getuid())'), '1000');
  execute(`import { existsSync, readdirSync } from 'node:fs';
    for (const file of ['.env', '.env.docker', '.git', '.deploy', 'src', 'node_modules/vite']) {
      if (existsSync('/app/' + file)) throw new Error('Unexpected image content: ' + file);
    }
    if (!existsSync('/app/server/assets/vibeq-seed-logo.png')) throw new Error('Missing seed');
    if (readdirSync('/app/data').some(f => f !== 'vibeq.sqlite' && !f.startsWith('vibeq.sqlite-'))) throw new Error('Unexpected data');`);
  for (const page of ['/', '/player/']) {
    const response = await fetch(base + page);
    assert.equal(response.status, 200); assert.match(await response.text(), /vibeQ/i);
  }
  const configuration = await api('/config');
  console.log('Verified non-root user, image contents, homepage, player and API.');
  assert.equal(configuration.features.artwork, false); assert.equal(configuration.features.trivia, false);
  const { token } = await api('/host/login', { password });
  const authorization = new URL((await api('/spotify/connect', {}, token)).url);
  assert.equal(authorization.searchParams.get('redirect_uri'), 'http://127.0.0.1:3001/api/spotify/callback');
  // Seed completed/pending tracks without contacting a real Spotify account.
  execute(`import { config } from 'file:///app/server/config.js'; import { createStore } from 'file:///app/server/store.js';
    const store = await createStore(config());
    const song = { trackUri: 'spotify:track:1234567890123456789012', trackName: 'Container test', artist: 'Test', durationMs: 200000,
      guestId: 'guest-123456789012', voters: [], votes: 0, createdAt: new Date().toISOString() };
    await store.put('requests', { ...song, id: 'pending', status: 'pending' });
    await store.put('requests', { ...song, id: 'played', status: 'played', playedAt: new Date().toISOString() });
    store.close();`);
  assert.equal((await api('/votes', { id: 'pending', guestId: 'guest-223456789012' })).request.votes, 1);
  const { archive } = await api('/archives', { name: 'Container persistence test' }, token);
  assert.equal(archive.tracks.length, 1);
  console.log('Saved a set and vote; replacing the container with the same volume.');
  stop(); docker('rm', name);
  start(); await ready();
  assert.equal((await api('/archives')).archives[0].id, archive.id);
  const state = await api('/state');
  assert.equal(state.pending[0].votes, 1); assert.equal(typeof state.pending[0].fairScore, 'number');
  console.log('Saved set and queue survived replacement; checking restart and healthcheck.');
  stop(); docker('start', name); await ready();
  assert.equal((await api('/archives')).archives.length, 1);
  for (let attempt = 0; attempt < 45; attempt++) {
    const health = docker('inspect', '--format', '{{.State.Health.Status}}', name);
    if (health === 'healthy') break;
    assert.notEqual(health, 'unhealthy');
    if (attempt === 44) throw new Error('Healthcheck did not become healthy');
    await delay(1000);
  }
  stop();
  console.log('PASS: non-root runtime, clean image, HTTP, host login, OAuth URL, voting, FPQS state, saved set, replacement persistence, restart, healthcheck and graceful shutdown.');
  console.log('Real Spotify OAuth/playback/search and configured AI provider tests are separate manual checks.');
} finally {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30000 });
  spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore', timeout: 30000 });
}
