import { HttpError } from './auth.js';
import { update, withLease } from './store.js';
export function track(item) {
  if (!item || item.type !== 'track' || !/^spotify:track:[a-zA-Z0-9]{22}$/.test(item.uri || '')) return null;
  return { id: item.id, trackUri: item.uri, trackName: item.name, artist: (item.artists || []).map(a => a.name).join(', '), albumArt: item.album?.images?.[0]?.url || null, durationMs: item.duration_ms, spotifyUrl: item.external_urls?.spotify || `https://open.spotify.com/track/${item.id}` };
}
export class Spotify {
  constructor(cfg, store, fetcher = fetch) { this.cfg = cfg; this.store = store; this.fetcher = fetcher; }
  async exchange(params) {
    if (!this.cfg.clientId || !this.cfg.clientSecret) throw new HttpError(503, 'Configure Spotify credentials first.');
    const response = await this.fetcher('https://accounts.spotify.com/api/token', {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 502, 'Spotify authorization failed. Reconnect your account.', response.headers.get('retry-after'));
    const value = await response.json();
    return { id: 'spotify', accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: Date.now() + value.expires_in * 1000, scope: value.scope };
  }
  async token() {
    const current = await this.store.get('system', 'spotify');
    if (!current) throw new HttpError(409, 'The host needs to connect Spotify.');
    if (Date.now() < current.expiresAt - 60000) return current.accessToken;
    const result = await withLease(this.store, 'spotify-refresh', async () => {
      const latest = await this.store.get('system', 'spotify');
      if (Date.now() < latest.expiresAt - 60000) return latest;
      const refreshed = await this.exchange({ grant_type: 'refresh_token', refresh_token: latest.refreshToken });
      return update(this.store, 'system', 'spotify', before => before?._etag === latest._etag ? { ...refreshed, refreshToken: refreshed.refreshToken || latest.refreshToken } : null);
    });
    if (result.busy) throw new HttpError(503, 'Spotify connection is refreshing. Try again shortly.');
    return result.accessToken;
  }
  async call(endpoint, method = 'GET', body) {
    const rate = await this.store.get('system', 'spotify-backoff');
    if (rate?.until > Date.now()) throw new HttpError(429, 'Spotify is rate limiting requests.', Math.ceil((rate.until - Date.now()) / 1000));
    const response = await this.fetcher(`https://api.spotify.com/v1/${endpoint}`, {
      method, headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    if (response.status === 429) {
      const seconds = Math.max(1, Number(response.headers.get('retry-after')) || 30);
      await update(this.store, 'system', 'spotify-backoff', () => ({ until: Date.now() + seconds * 1000 }));
      throw new HttpError(429, 'Spotify is rate limiting requests.', seconds);
    }
    if (!response.ok) {
      const messages = { 401: 'Spotify connection expired. Reconnect your account.', 403: 'Spotify denied this action. Check Premium, app access, and granted scopes.', 404: 'No active Spotify device. Open Spotify and start playback first.' };
      throw new HttpError(response.status === 404 ? 409 : 502, messages[response.status] || 'Spotify request failed.');
    }
    // Playback commands acknowledge success without a JSON resource. Some
    // devices return 200/202 with an opaque body instead of an empty 204.
    if (response.status === 204 || method !== 'GET') {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    try { return await response.json(); }
    catch { throw new HttpError(502, 'Spotify returned an invalid response. Try again shortly.'); }
  }
}
