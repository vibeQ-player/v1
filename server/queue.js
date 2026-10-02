import fairQueue from './fair-queue.cjs';
import { withLease, update } from './store.js';
export const { fairSortPending } = fairQueue;

export async function tick(store, spotify) {
  if (!(await store.get('system', 'spotify'))) return { connected: false };
  return withLease(store, 'queue', async () => {
    const playback = await spotify.call('me/player');
    await update(store, 'system', 'playback', () => ({ data: playback, checkedAt: Date.now() }));
    if (!playback?.device || !playback.item || !playback.is_playing) return { idle: true };
    const live = await spotify.call('me/player/queue');
    if (!live || !Array.isArray(live.queue)) return { idle: true };
    const currentUri = live.currently_playing?.uri || playback.item.uri;
    const holding = new Set(live.queue.map(item => item.uri));
    const requests = await store.list('requests');
    for (const item of requests.filter(r => ['queued', 'submitting', 'playing'].includes(r.status))) {
      if (item.trackUri === currentUri) {
        await update(store, 'requests', item.id, before => ({ ...before, status: 'playing', playedAt: before.playedAt || new Date().toISOString() }));
      } else if (item.status === 'playing') {
        await update(store, 'requests', item.id, before => ({ ...before, status: 'played' }));
      } else if (holding.has(item.trackUri) && item.status === 'submitting') {
        await update(store, 'requests', item.id, before => ({ ...before, status: 'queued' }));
      } else if (!holding.has(item.trackUri) && Date.now() - Date.parse(item.queuedAt) > 180000) {
        // Only witnessed playback enters archives; a dropped track becomes skipped.
        // An ambiguous POST is never blindly retried, preventing duplicate inserts.
        await update(store, 'requests', item.id, before => ({ ...before, status: 'skipped' }));
      }
    }
    const latest = await store.list('requests');
    if (latest.filter(r => ['queued', 'submitting'].includes(r.status)).length >= 3) return { full: true };
    const { sorted } = fairSortPending(latest.map(r => r.status === 'playing' ? { ...r, status: 'played' } : r));
    const next = sorted[0];
    if (!next) return { empty: true };
    await update(store, 'requests', next.id, before => ({ ...before, status: 'submitting', queuedAt: new Date().toISOString() }));
    try {
      await spotify.call(`me/player/queue?uri=${encodeURIComponent(next.trackUri)}&device_id=${encodeURIComponent(playback.device.id)}`, 'POST');
    } catch (error) {
      // Known HTTP rejections did not enqueue. Network failures are ambiguous.
      if (error.status) await update(store, 'requests', next.id, before => ({ ...before, status: 'pending' }));
      throw error;
    }
    await update(store, 'requests', next.id, before => ({ ...before, status: 'queued' }));
    return { queued: next.id };
  });
}
