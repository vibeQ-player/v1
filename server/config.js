import path from 'node:path';
export function config(env = process.env) {
  const flag = (key, fallback = false) => env[key] === undefined ? fallback : env[key] === 'true';
  const cfg = {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3001), origin: env.APP_ORIGIN || 'http://127.0.0.1:5173',
    redirectUri: env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:5173/api/spotify/callback',
    clientId: env.SPOTIFY_CLIENT_ID || '', clientSecret: env.SPOTIFY_CLIENT_SECRET || '',
    hostPassword: env.HOST_PASSWORD || '', sessionSecret: env.SESSION_SECRET || '',
    storage: env.STORAGE_DRIVER || 'sqlite', dataDir: path.resolve(env.DATA_DIR || 'data'),
    cosmosEndpoint: env.COSMOS_ENDPOINT, cosmosKey: env.COSMOS_KEY,
    cosmosDatabase: env.COSMOS_DATABASE || 'vibeq',
    blobConnection: env.ARTWORK_STORAGE_CONNECTION_STRING,
    aiBase: (env.AI_BASE_URL || '').replace(/\/$/, ''), aiKey: env.AI_API_KEY || '',
    aiAuthHeader: env.AI_AUTH_HEADER || 'api-key', imageModel: env.AI_IMAGE_MODEL,
    triviaModel: env.AI_TRIVIA_MODEL, triviaFormatModel: env.AI_TRIVIA_FORMAT_MODEL || env.AI_TRIVIA_MODEL,
    triviaSearchTool: env.AI_TRIVIA_SEARCH_TOOL || 'web_search',
    addonLimit: env.ADDON_DAILY_LIMIT === 'unlimited' ? Infinity : Number(env.ADDON_DAILY_LIMIT || 10),
    features: { archives: flag('ENABLE_ARCHIVES', true), artwork: flag('ENABLE_ARTWORK'), trivia: flag('ENABLE_TRIVIA'), browserPlayer: flag('ENABLE_BROWSER_PLAYER') },
  };
  if (cfg.hostPassword.length < 12 || cfg.sessionSecret.length < 32) throw new Error('Set HOST_PASSWORD (12+ characters) and SESSION_SECRET (32+ characters) in .env or Azure settings.');
  if (!['sqlite', 'cosmos'].includes(cfg.storage)) throw new Error('STORAGE_DRIVER must be sqlite or cosmos.');
  const origin = new URL(cfg.origin), redirect = new URL(cfg.redirectUri);
  for (const url of [origin, redirect]) {
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('APP_ORIGIN and SPOTIFY_REDIRECT_URI must use HTTPS or an explicit loopback IP.');
  }
  if (origin.origin !== cfg.origin || redirect.pathname !== '/api/spotify/callback') throw new Error('APP_ORIGIN must be an origin without trailing slash; callback path must be /api/spotify/callback.');
  if (cfg.addonLimit !== Infinity && (!Number.isInteger(cfg.addonLimit) || cfg.addonLimit < 0)) throw new Error('ADDON_DAILY_LIMIT must be a nonnegative integer or unlimited.');
  if (!['web_search', 'web_search_preview'].includes(cfg.triviaSearchTool)) throw new Error('AI_TRIVIA_SEARCH_TOOL must be web_search or web_search_preview.');
  return cfg;
}
