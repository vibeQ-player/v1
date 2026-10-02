import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
export class HttpError extends Error {
  constructor(status, message, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
export function equal(a, b) {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}
export function session(cfg, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + 8 * 3600000, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  return `${payload}.${createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url')}`;
}
export function requireHost(request, cfg, now = Date.now()) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  const [payload, signature] = token.split('.');
  try {
    if (!payload || !equal(signature, createHmac('sha256', cfg.sessionSecret).update(payload).digest('base64url')) || JSON.parse(Buffer.from(payload, 'base64url')).exp <= now) throw new Error();
  } catch { throw new HttpError(401, 'Host sign-in required.'); }
}
