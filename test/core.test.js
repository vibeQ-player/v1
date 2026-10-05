import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../server/config.js';
import { createStore, Conflict, update, withLease } from '../server/store.js';
import { createApp } from '../server/app.js';
import { session, requireHost } from '../server/auth.js';
import { fairSortPending, tick } from '../server/queue.js';
import { citedTrivia, createAddons } from '../server/addons.js';
import { Spotify } from '../server/spotify.js';

const uri = 'spotify:track:1234567890123456789012';
const item = { id: uri.split(':')[2], type: 'track', uri, name: 'Test song', artists: [{ name: 'Artist' }], album: { images: [] }, duration_ms: 200000 };
const request = (id, status = 'pending', extra = {}) => ({ id, status, trackUri: uri, trackName: 'Test song', guestId: 'guest-123456789012', voters: [], votes: 0, createdAt: new Date().toISOString(), ...extra });
async function fixture(t, flags = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vibeq-test-'));
  const cfg = config({ HOST_PASSWORD: 'testing-password', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters', SPOTIFY_CLIENT_ID: 'client', SPOTIFY_CLIENT_SECRET: 'secret', DATA_DIR: dataDir, ...flags });
  const store = await createStore(cfg);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { cfg, store };
}
function req(path, data, token) { return new Request(`http://127.0.0.1:5173/api${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) }); }

test('configuration refuses weak host credentials and localhost callbacks', () => {
  assert.throws(() => config({}), /HOST_PASSWORD/);
  assert.throws(() => config({ HOST_PASSWORD: 'testing-password', SESSION_SECRET: 'a'.repeat(32), SPOTIFY_REDIRECT_URI: 'http://localhost:5173/api/spotify/callback' }), /HTTPS/);
});
test('host tokens reject tampering and expire', () => {
  const cfg = { sessionSecret: 'secret' }, token = session(cfg, 1000);
  requireHost(req('/state', undefined, token), cfg, 2000);
  assert.throws(() => requireHost(req('/state', undefined, token + 'x'), cfg, 2000), /sign-in/);
  assert.throws(() => requireHost(req('/state', undefined, token), cfg, 1000 + 8 * 3600000), /sign-in/);
});
test('SQLite persists data and detects stale writes', async t => {
  const { cfg, store } = await fixture(t);
  const first = await store.put('requests', request('one'));
  await store.put('requests', { ...first, votes: 1 }, first._etag);
  await assert.rejects(store.put('requests', { ...first, votes: 2 }, first._etag), Conflict);
  const reopened = await createStore(cfg);
  assert.equal((await reopened.get('requests', 'one')).votes, 1); reopened.close();
});
test('distributed lease excludes overlapping workers and releases after failure', async t => {
  const { store } = await fixture(t);
  let entered; const enteredPromise = new Promise(resolve => entered = resolve);
  let release; const held = new Promise(resolve => release = resolve);
  const first = withLease(store, 'work', async () => { entered(); await held; throw new Error('failed'); });
  await enteredPromise;
  assert.deepEqual(await withLease(store, 'work', () => assert.fail('overlap')), { busy: true });
  release(); await assert.rejects(first, /failed/);
  assert.equal(await withLease(store, 'work', () => 'released'), 'released');
});
test('fair queue gives different guests a turn and includes recent archive debt', () => {
  const all = [request('a1', 'played', { guestId: 'a', votes: 0, playedAt: new Date().toISOString(), archivedAt: new Date().toISOString() }), request('a2', 'pending', { guestId: 'a' }), request('b1', 'pending', { guestId: 'b' })];
  assert.deepEqual(fairSortPending(all).sorted.map(r => r.id), ['b1', 'a2']);
  all[1].votes = 20; assert.ok(fairSortPending(all).scoreOf.a2 < 2);
});
test('FPQS combines the two-hour history, Spotify buffer, and vote-ranked pending line', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const all = [
    request('expired', 'played', { guestId: 'a', playedAt: '2026-10-04T09:59:59Z' }),
    request('recent', 'played', { guestId: 'a', votes: 1, playedAt: '2026-10-04T10:00:00Z' }),
    request('buffer', 'queued', { guestId: 'a', votes: 3 }),
    request('older', 'pending', { guestId: 'a', createdAt: '2026-10-04T11:00:00Z', durationMs: 60000 }),
    request('popular', 'pending', { guestId: 'a', votes: 3, createdAt: '2026-10-04T11:30:00Z', durationMs: 600000 }),
    request('new-guest', 'pending', { guestId: 'b', createdAt: '2026-10-04T11:45:00Z' })
  ];
  const result = fairSortPending(all, now);
  assert.equal(result.scoreOf.popular, 1); // 0.5 history + 0.25 buffer + 0.25 song
  assert.equal(result.scoreOf.older, 2);
  assert.equal(result.scoreOf['new-guest'], 1);
  assert.deepEqual(result.sorted.map(r => r.id), ['popular', 'new-guest', 'older']);
});

test('public configuration and state never expose host secrets or Spotify tokens', async t => {
  const { cfg, store } = await fixture(t);
  await store.put('system', { id: 'spotify', accessToken: 'TOPSECRET', refreshToken: 'REFRESH' });
  await store.put('requests', request('one', 'pending', { voters: ['guest-123456789012'], votes: 1 }));
  const app = createApp(cfg, store);
  const text = await (await app.handle(req('/state'))).text();
  assert.ok(!text.includes('TOPSECRET') && !text.includes('REFRESH') && !text.includes('guest-123456789012'));
  assert.equal((await app.handle(req('/spotify/devices'))).status, 401);
  const evil = new Request('http://127.0.0.1:5173/api/state', { headers: { Origin: 'https://evil.example' } });
  assert.equal((await app.handle(evil)).status, 403);
});
test('OAuth state is random, one-use, and callback returns only to configured origin', async t => {
  const { cfg, store } = await fixture(t);
  const app = createApp(cfg, store, { spotify: { async exchange() { return { id: 'spotify', accessToken: 'token', refreshToken: 'refresh' }; } } });
  const token = session(cfg);
  const connect = await (await app.handle(req('/spotify/connect', {}, token))).json();
  const state = new URL(connect.url).searchParams.get('state');
  assert.ok(state.length > 32);
  const callback = req(`/spotify/callback?state=${state}&code=test`);
  const result = await app.handle(callback);
  assert.equal(result.status, 302); assert.equal(result.headers.get('Location'), cfg.origin + '/?connected=1');
  assert.equal((await app.handle(callback)).status, 400);
  assert.equal((await app.handle(req('/spotify/callback?state=bad&code=test'))).status, 400);
});
test('concurrent votes retain all voters and repeated voting is idempotent', async t => {
  const { cfg, store } = await fixture(t);
  await store.put('requests', request('one'));
  const app = createApp(cfg, store);
  const voters = ['guest-123456789012', 'guest-223456789012', 'guest-323456789012'];
  const replies = await Promise.all(voters.map(guestId => app.handle(req('/votes', { id: 'one', guestId }))));
  assert.ok(replies.every(r => r.status === 200));
  await app.handle(req('/votes', { id: 'one', guestId: voters[0] }));
  assert.equal((await store.get('requests', 'one')).votes, 3);
});
test('request metadata comes from Spotify and duplicate requests are rejected', async t => {
  const { cfg, store } = await fixture(t);
  const app = createApp(cfg, store, { spotify: { async call() { return item; } } });
  const response = await app.handle(req('/requests', { trackUri: uri, trackName: 'Injected name', guestId: 'guest-123456789012' }));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).request.trackName, 'Test song');
  assert.equal((await app.handle(req('/requests', { trackUri: uri, guestId: 'guest-223456789012' }))).status, 409);
});
test('queue advances without a browser and preserves paused buffered tracks', async t => {
  const { store } = await fixture(t);
  await store.put('system', { id: 'spotify' }); await store.put('requests', request('one'));
  const calls = [];
  const spotify = { async call(endpoint, method) { calls.push([endpoint, method]); if (endpoint === 'me/player') return { device: { id: 'device' }, item, is_playing: true }; if (endpoint === 'me/player/queue') return { currently_playing: item, queue: [] }; return null; } };
  await tick(store, spotify); assert.equal((await store.get('requests', 'one')).status, 'queued');
  assert.equal(calls.filter(([,method]) => method === 'POST').length, 1);
  const paused = { async call() { return { device: { id: 'device' }, item, is_playing: false }; } };
  await tick(store, paused); assert.equal((await store.get('requests', 'one')).status, 'queued');
});
test('ambiguous Spotify POST is not retried and dropped tracks do not enter played history', async t => {
  const { store } = await fixture(t);
  await store.put('system', { id: 'spotify' }); await store.put('requests', request('one'));
  let posts = 0;
  const spotify = { async call(endpoint, method) { if (method === 'POST') { posts++; throw new Error('network timeout'); } if (endpoint === 'me/player') return { device: { id: 'device' }, item: { ...item, uri: 'spotify:track:2234567890123456789012' }, is_playing: true }; return { queue: [], currently_playing: { uri: 'spotify:track:2234567890123456789012' } }; } };
  await assert.rejects(tick(store, spotify), /timeout/);
  await tick(store, spotify); assert.equal(posts, 1);
  await update(store, 'requests', 'one', old => ({ ...old, queuedAt: new Date(Date.now() - 240000).toISOString() }));
  await tick(store, spotify); assert.equal((await store.get('requests', 'one')).status, 'skipped');
});
test('archive saves completed tracks, keeps fairness history, and replay deduplicates', async t => {
  const { cfg, store } = await fixture(t);
  await store.put('requests', request('one', 'played', { playedAt: new Date().toISOString() }));
  const app = createApp(cfg, store), token = session(cfg);
  assert.equal((await app.handle(req('/archives', {}))).status, 401);
  const saved = await app.handle(req('/archives', { name: 'Friday' }, token));
  assert.equal(saved.status, 201); const { archive } = await saved.json();
  assert.equal((await store.get('requests', 'one')).status, 'played');
  assert.equal((await app.handle(req('/archives', {}, token))).status, 409);
  const replay = await (await app.handle(req('/archives/replay', { id: archive.id }, token))).json(); assert.equal(replay.added, 1);
  assert.equal((await (await app.handle(req('/archives/replay', { id: archive.id }, token))).json()).added, 0);
});
test('disabled add-ons make no provider requests; trivia requires source annotations', async t => {
  const { cfg, store } = await fixture(t);
  const addons = createAddons(cfg, store, () => assert.fail('AI must not be called'));
  assert.deepEqual(await addons.generate(request('one')), { idle: true });
  assert.deepEqual(citedTrivia({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Unsourced claim' }] }] }), []);
  const output = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Researched fact', annotations: [{ type: 'url_citation', url: 'https://example.org', title: 'Source' }] }] }] };
  assert.equal(citedTrivia(output)[0].sources[0].url, 'https://example.org');
});
test('Spotify 429 backoff is persisted and prevents repeated outbound calls', async t => {
  const { cfg, store } = await fixture(t);
  await store.put('system', { id: 'spotify', accessToken: 'token', expiresAt: Date.now() + 3600000 });
  let calls = 0;
  const spotify = new Spotify(cfg, store, async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '30' } }); });
  await assert.rejects(spotify.call('search'), error => error.status === 429);
  await assert.rejects(spotify.call('search'), error => error.status === 429);
  assert.equal(calls, 1);
});
test('artwork is cached locally and daily limits bound new AI calls', async t => {
  const { cfg, store } = await fixture(t, { ENABLE_ARTWORK: 'true', AI_BASE_URL: 'https://provider.example/v1', AI_API_KEY: 'fake', AI_IMAGE_MODEL: 'image', ADDON_DAILY_LIMIT: '1' });
  let calls = 0;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VbQAAAAASUVORK5CYII=';
  const addons = createAddons(cfg, store, async () => { calls++; return new Response(JSON.stringify({ data: [{ b64_json: png }] })); });
  const first = await addons.generate(request('one'));
  assert.ok(first.processed);
  assert.equal((await addons.image(first.processed)).subarray(0,8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(await addons.generate(request('one')), { idle: true });
  assert.deepEqual(await addons.generate(request('two', 'pending', { trackUri: 'spotify:track:2234567890123456789012' })), { limit: true });
  assert.equal(calls, 1);
});

test('unlimited add-ons generate and remain available without Spotify playback', async t => {
  const { cfg, store } = await fixture(t, { ENABLE_ARTWORK: 'true', ENABLE_TRIVIA: 'true', AI_BASE_URL: 'https://provider.example/v1', AI_API_KEY: 'fake', AI_IMAGE_MODEL: 'image', AI_TRIVIA_MODEL: 'facts', ADDON_DAILY_LIMIT: 'unlimited' });
  assert.equal(cfg.addonLimit, Infinity);
  let calls = 0;
  const output = text => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
  const addons = createAddons(cfg, store, async (url, options) => {
    calls++;
    if (url.endsWith('/images/edits')) {
      assert.ok(options.body instanceof FormData);
      assert.ok(options.body.get('image[]').size > 0);
      assert.equal(options.body.get('model'), 'image');
      return new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VbQAAAAASUVORK5CYII=' }] }));
    }
    const body = JSON.parse(options.body);
    if (body.tools) {
      const research = output('An unusual recording story.');
      research.output[0].content[0].annotations = [{ type: 'url_citation', url: 'https://source.example/story', title: 'Recording story' }];
      return new Response(JSON.stringify(research));
    }
    assert.ok(body.text.format.strict);
    return new Response(JSON.stringify(output(JSON.stringify({ items: [
      { kind: 'fact', text: 'An unusual recording story.', sourceUrl: 'https://source.example/story' },
      { kind: 'fact', text: 'Invented citation must be dropped.', sourceUrl: 'https://invented.example' }
    ] }))));
  });
  const app = createApp(cfg, store, { addons });
  await store.put('requests', request('one', 'played', { playedAt: new Date().toISOString() }));
  assert.ok((await app.generateAddons()).processed);
  assert.deepEqual(await app.generateAddons(), { idle: true });
  assert.equal(calls, 3);
  const state = await (await app.handle(req('/state'))).json();
  assert.equal(state.playback.track, null);
  assert.equal(state.triviaFeed.length, 1);
  assert.equal(state.triviaFeed[0].text, 'An unusual recording story.');
  assert.ok(state.played[0].customArt.endsWith('?v=2'));
  const saved = await (await app.handle(req('/archives', {}, session(cfg)))).json();
  const archive = await (await app.handle(req(`/archives?id=${saved.archive.id}`))).json();
  assert.equal(archive.archive.tracks[0].customArt, state.played[0].customArt);
  assert.equal((await (await app.handle(req('/state'))).json()).triviaFeed.length, 1);
});
