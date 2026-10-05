import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { HttpError, equal, session, requireHost } from './auth.js';
import { update, withLease, Conflict } from './store.js';
import { Spotify, track } from './spotify.js';
import { tick, fairSortPending } from './queue.js';
import { addonKey, createAddons } from './addons.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const hash = value => createHash('sha256').update(value).digest('hex');
const cleanRequest = item => {
  const { guestId, voters, _etag, collection, _rid, _self, _attachments, _ts, ...publicItem } = item;
  return publicItem;
};
export function createApp(cfg, store, options = {}) {
  const spotify = options.spotify || new Spotify(cfg, store);
  const addons = options.addons || createAddons(cfg, store);
  async function body(request) {
    const text = await request.text();
    if (text.length > 16384) throw new HttpError(413, 'Request too large.');
    try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  }
  async function limited(key, limit, windowMs = 60000) {
    let exceeded;
    await update(store, 'limits', hash(key), old => {
      const count = old?.until > Date.now() ? old.count + 1 : 1;
      exceeded = count > limit;
      return { count: Math.min(count, limit + 1), until: old?.until > Date.now() ? old.until : Date.now() + windowMs, ttl: Math.ceil(windowMs / 1000) + 60 };
    });
    if (exceeded) throw new HttpError(429, 'Too many requests. Try again shortly.', Math.ceil(windowMs / 1000));
  }
  function guest(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) throw new HttpError(400, 'A valid guest ID is required.');
    return value;
  }
  function feature(name) { if (!cfg.features[name]) throw new HttpError(404, 'This add-on is disabled.'); }
  async function route(request, context) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    if (path === '/api/health' && method === 'GET') return json({ ok: true });
    if (path === '/api/config' && method === 'GET') return json({ features: cfg.features, configured: { spotify: Boolean(cfg.clientId && cfg.clientSecret), artwork: addons.configured('artwork'), trivia: addons.configured('trivia') } });
    if (path === '/api/host/login' && method === 'POST') {
      await limited(`login:${context.clientIp || 'unknown'}`, 8, 15 * 60000);
      const data = await body(request);
      if (!equal(data.password, cfg.hostPassword)) throw new HttpError(401, 'Incorrect host password.');
      return json({ token: session(cfg) });
    }
    if (path === '/api/spotify/connect' && method === 'POST') {
      requireHost(request, cfg);
      if (!cfg.clientId || !cfg.clientSecret) throw new HttpError(503, 'Configure Spotify credentials first.');
      const nonce = randomBytes(32).toString('base64url');
      await store.put('oauth', { id: hash(nonce), expiresAt: Date.now() + 10 * 60000, used: false, ttl: 600 });
      const scope = ['user-modify-playback-state', 'user-read-playback-state', 'user-read-currently-playing'];
      if (cfg.features.browserPlayer) scope.push('streaming', 'user-read-email', 'user-read-private');
      const params = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', redirect_uri: cfg.redirectUri, scope: scope.join(' '), state: nonce });
      return json({ url: `https://accounts.spotify.com/authorize?${params}` });
    }
    if (path === '/api/spotify/callback' && method === 'GET') {
      const nonce = url.searchParams.get('state') || '';
      const record = await store.get('oauth', hash(nonce));
      if (!record || record.used || record.expiresAt <= Date.now()) throw new HttpError(400, 'Invalid or expired Spotify authorization state. Connect again from the host panel.');
      await store.put('oauth', { ...record, used: true }, record._etag);
      if (url.searchParams.has('error')) throw new HttpError(400, 'Spotify authorization was declined.');
      if (!url.searchParams.get('code')) throw new HttpError(400, 'Missing Spotify authorization code.');
      const tokens = await spotify.exchange({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: cfg.redirectUri });
      const saved = await withLease(store, 'spotify-refresh', async () => update(store, 'system', 'spotify', () => tokens));
      if (saved.busy) throw new HttpError(409, 'Another Spotify connection is being updated. Connect again shortly.');
      return new Response(null, { status: 302, headers: { Location: `${cfg.origin}/?connected=1`, 'Cache-Control': 'no-store' } });
    }
    if (path === '/api/spotify/token' && method === 'GET') {
      requireHost(request, cfg); feature('browserPlayer');
      return json({ accessToken: await spotify.token() });
    }
    if (path === '/api/spotify/devices' && method === 'GET') { requireHost(request, cfg); return json(await spotify.call('me/player/devices')); }
    if (path === '/api/spotify/control' && method === 'POST') {
      requireHost(request, cfg); await limited('host-controls', 30);
      const data = await body(request), suffix = data.deviceId ? `?device_id=${encodeURIComponent(String(data.deviceId).slice(0, 128))}` : '';
      const commands = { play: ['me/player/play', 'PUT'], pause: ['me/player/pause', 'PUT'], next: ['me/player/next', 'POST'], previous: ['me/player/previous', 'POST'], volume: ['me/player/volume', 'PUT'], transfer: ['me/player', 'PUT'] };
      if (!commands[data.command]) throw new HttpError(400, 'Unsupported playback command.');
      let [endpoint, verb] = commands[data.command], payload;
      if (data.command === 'volume') {
        if (!Number.isInteger(data.volume) || data.volume < 0 || data.volume > 100) throw new HttpError(400, 'Volume must be 0–100.');
        endpoint += `?volume_percent=${data.volume}${data.deviceId ? `&device_id=${encodeURIComponent(data.deviceId)}` : ''}`;
      } else if (data.command === 'transfer') {
        if (!data.deviceId) throw new HttpError(400, 'Choose a device first.');
        payload = { device_ids: [data.deviceId], play: true };
      } else endpoint += suffix;
      await spotify.call(endpoint, verb, payload);
      return json({ success: true });
    }
    if (path === '/api/search' && method === 'GET') {
      await limited(`search:${context.clientIp || 'unknown'}`, 20);
      const query = (url.searchParams.get('q') || '').trim().slice(0, 150);
      if (query.length < 2) return json({ tracks: [] });
      const result = await spotify.call(`search?${new URLSearchParams({ q: query, type: 'track', limit: '10' })}`);
      return json({ tracks: (result.tracks?.items || []).map(track).filter(Boolean) });
    }
    if (path === '/api/state' && method === 'GET') {
      const items = await store.list('requests'), { sorted, scoreOf } = fairSortPending(items.map(item => item.status === 'playing' ? { ...item, status: 'played' } : item));
      const cached = cfg.features.artwork || cfg.features.trivia ? await store.list('addons') : [];
      const enrich = item => ({ ...cleanRequest(item), customArt: cfg.features.artwork ? cached.find(a => a.id === addonKey(item.trackUri))?.artwork || null : null });
      const playback = await store.get('system', 'playback');
      const nowPlaying = track(playback?.data?.item);
      const nowAddon = nowPlaying ? cached.find(a => a.id === addonKey(nowPlaying.trackUri)) : null;
      const budget = await store.get('system', `addon-budget-${new Date().toISOString().slice(0, 10)}`);
      const addonStatus = Object.fromEntries(['artwork', 'trivia'].map(kind => [kind,
        !cfg.features[kind] ? 'disabled' : !addons.configured(kind) ? 'unconfigured' : !nowPlaying ? 'waiting-playback' :
        nowAddon?.[kind] ? 'ready' : nowAddon?.failedAt?.[kind] && Date.now() - nowAddon.failedAt[kind] < 3600000 ? 'unavailable' :
        (budget?.count || 0) >= cfg.addonLimit ? 'daily-limit' : 'generating'
      ]));
      return json({ connected: Boolean(await store.get('system', 'spotify')), playback: { track: nowPlaying, isPlaying: playback?.data?.is_playing || false, deviceName: playback?.data?.device?.name || null, checkedAt: playback?.checkedAt || null }, pending: sorted.map(r => ({ ...enrich(r), fairScore: scoreOf[r.id] })), queued: items.filter(r => ['queued', 'submitting'].includes(r.status)).sort((a,b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt)).map(enrich), played: items.filter(r => ['played', 'playing'].includes(r.status) && !r.archivedAt).sort((a,b) => Date.parse(b.playedAt) - Date.parse(a.playedAt)).slice(0, 50).map(enrich), addonStatus, trivia: cfg.features.trivia ? nowAddon?.trivia || [] : [], customArt: cfg.features.artwork ? nowAddon?.artwork || null : null });
    }
    if (path === '/api/requests' && method === 'POST') {
      const data = await body(request), guestId = guest(data.guestId);
      await limited(`request:${guestId}`, 8); await limited(`request-ip:${context.clientIp || 'unknown'}`, 20);
      if (!/^spotify:track:[a-zA-Z0-9]{22}$/.test(data.trackUri || '')) throw new HttpError(400, 'Invalid Spotify track URI.');
      const metadata = track(await spotify.call(`tracks/${data.trackUri.split(':')[2]}`));
      if (!metadata) throw new HttpError(400, 'This item cannot be requested.');
      const result = await withLease(store, 'requests', async () => {
        const all = await store.list('requests');
        const duplicate = all.find(r => r.trackUri === metadata.trackUri && ['pending', 'submitting', 'queued', 'playing'].includes(r.status));
        if (duplicate) throw new HttpError(409, 'That track is already in the queue. Vote for it instead.');
        if (all.filter(r => ['pending', 'queued', 'submitting'].includes(r.status)).length >= 100) throw new HttpError(409, 'The queue is full. Try again later.');
        if (all.filter(r => r.guestId === guestId && r.status === 'pending').length >= 5) throw new HttpError(409, 'You already have five pending requests.');
        const request = { ...metadata, id: randomUUID(), guestId, voters: [guestId], votes: 1, status: 'pending', createdAt: new Date().toISOString() };
        await store.put('requests', request);
        return { request: cleanRequest(request) };
      });
      if (result.busy) throw new HttpError(409, 'Queue is busy. Please retry.');
      return json(result, 201);
    }
    if (path === '/api/votes' && method === 'POST') {
      const data = await body(request), guestId = guest(data.guestId);
      await limited(`vote:${guestId}`, 30); await limited(`vote-ip:${context.clientIp || 'unknown'}`, 60);
      const saved = await update(store, 'requests', String(data.id || ''), before => {
        if (!before) throw new HttpError(404, 'Request not found.');
        if (before.status !== 'pending') throw new HttpError(409, 'This track is already committed to playback.');
        const voters = new Set(before.voters || []);
        if (data.remove) voters.delete(guestId); else voters.add(guestId);
        return { ...before, voters: [...voters], votes: voters.size };
      });
      return json({ request: cleanRequest(saved) });
    }
    if (path === '/api/requests/delete' && method === 'POST') {
      requireHost(request, cfg); const data = await body(request);
      await update(store, 'requests', String(data.id || ''), before => {
        if (!before) throw new HttpError(404, 'Request not found.');
        if (before.status !== 'pending') throw new HttpError(409, 'Only pending tracks can be removed.');
        return { ...before, status: 'deleted' };
      }); return json({ success: true });
    }
    if (path === '/api/archives' && method === 'GET') {
      feature('archives');
      const archives = await store.list('archives');
      const id = url.searchParams.get('id');
      if (id) { const archive = archives.find(a => a.id === id); if (!archive) throw new HttpError(404, 'Archive not found.'); return json({ archive: cleanRequest(archive) }); }
      return json({ archives: archives.sort((a,b) => Date.parse(b.savedAt) - Date.parse(a.savedAt)).map(a => ({ id: a.id, name: a.name, savedAt: a.savedAt, trackCount: a.tracks.length })) });
    }
    if (path === '/api/archives' && method === 'POST') {
      requireHost(request, cfg); feature('archives'); const data = await body(request);
      const result = await withLease(store, 'archives', async () => {
        // Finish any interrupted archive stamping before taking another snapshot.
        const archives = await store.list('archives');
        const priorIds = new Set(archives.flatMap(a => a.requestIds));
        const requests = (await store.list('requests')).filter(r => r.status === 'played' && !r.archivedAt && !priorIds.has(r.id)).sort((a,b) => Date.parse(a.playedAt) - Date.parse(b.playedAt));
        if (!requests.length) throw new HttpError(409, 'No completed tracks to archive yet.');
        const archive = { id: randomUUID(), name: String(data.name || 'Saved session').trim().slice(0, 100), savedAt: new Date().toISOString(), tracks: requests.map(cleanRequest), requestIds: requests.map(r => r.id) };
        await store.put('archives', archive);
        for (const request of requests) await update(store, 'requests', request.id, before => ({ ...before, archivedAt: archive.savedAt }));
        return { archive: cleanRequest(archive) };
      });
      if (result.busy) throw new HttpError(409, 'Archive is being saved. Try again shortly.');
      return json(result, 201);
    }
    if (path === '/api/archives/replay' && method === 'POST') {
      requireHost(request, cfg); feature('archives'); const data = await body(request);
      const archive = await store.get('archives', String(data.id || ''));
      if (!archive) throw new HttpError(404, 'Archive not found.');
      const result = await withLease(store, 'requests', async () => {
        const all = await store.list('requests');
        const active = new Set(all.filter(r => ['pending', 'submitting', 'queued', 'playing'].includes(r.status)).map(r => r.trackUri));
        let count = all.filter(r => ['pending', 'submitting', 'queued'].includes(r.status)).length, added = 0;
        for (const item of archive.tracks) {
          if (count >= 100) break;
          if (active.has(item.trackUri)) continue;
          const request = { ...item, id: randomUUID(), guestId: 'host', voters: [], votes: 0, status: 'pending', createdAt: new Date().toISOString() };
          delete request.archivedAt; delete request.playedAt; delete request.queuedAt;
          await store.put('requests', request); active.add(item.trackUri); added++; count++;
        }
        return { added };
      });
      if (result.busy) throw new HttpError(409, 'Queue is busy. Please retry.');
      return json(result);
    }
    if (path.startsWith('/api/artwork/') && method === 'GET') {
      return new Response(await addons.image(path.split('/').pop()), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
    }
    throw new HttpError(404, 'Endpoint not found.');
  }
  return {
    spotify,
    async handle(request, context = {}) {
      try {
        const origin = request.headers.get('origin');
        if (origin && origin !== cfg.origin) throw new HttpError(403, 'Origin not allowed.');
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': cfg.origin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', Vary: 'Origin' } });
        const response = await route(request, context);
        if (origin) { response.headers.set('Access-Control-Allow-Origin', cfg.origin); response.headers.set('Vary', 'Origin'); }
        response.headers.set('X-Content-Type-Options', 'nosniff');
        return response;
      } catch (error) {
        const status = error.status || (error instanceof Conflict ? 409 : 500);
        if (status === 500) console.error('API operation failed:', error.message);
        return json({ error: status === 500 ? 'Something went wrong. Try again shortly.' : error.message }, status, { 'Access-Control-Allow-Origin': cfg.origin, ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) });
      }
    },
    async tick() { return tick(store, spotify); },
    async generateAddons() {
      if (!cfg.features.artwork && !cfg.features.trivia) return { idle: true };
      const playback = await store.get('system', 'playback');
      const current = track(playback?.data?.item);
      // Reserve the allowance for songs listeners actually hear.
      if (!current || !playback?.data?.is_playing) return { idle: true };
      return addons.generate(current);
    },
  };
}
