import fairQueue from './fair-queue.cjs';
import { withLease, update } from './store.js';
export const { fairSortPending } = fairQueue;

export async function tick(store, spotify) {
  if (!(await store.get('system', 'spotify'))) return { connected: false };
  return withLease(store, 'queue', async () => {
    const playback = await spotify.call('me/player');
    await update(store, 'system', 'playback', () => ({ data: playback, checkedAt: Date.now() }));
    const currentUris = new Set([playback?.item?.uri, playback?.item?.linked_from?.uri].filter(Boolean));
    const requests = await store.list('requests');
    for (const item of requests.filter(r => ['queued', 'submitting', 'playing'].includes(r.status))) {
      if (currentUris.has(item.trackUri)) {
        await update(store, 'requests', item.id, before => ({ ...before, status: 'playing', playedAt: before.playedAt || new Date().toISOString() }));
      } else if (item.status === 'playing' && playback?.item) {
        await update(store, 'requests', item.id, before => ({ ...before, status: 'played' }));
      }
    }
    // A paused new track still confirms that the previously observed request
    // finished. A missing device/204 does not prove a playback transition.
    if (!playback?.device || !playback.item || !playback.is_playing) return { idle: true };
    const live = await spotify.call('me/player/queue');
    if (!live || !Array.isArray(live.queue)) return { idle: true };
    const holding = new Set(live.queue.flatMap(item => [item.uri, item.linked_from?.uri]).filter(Boolean));
    for (const item of (await store.list('requests')).filter(r => ['queued', 'submitting'].includes(r.status))) {
      if (holding.has(item.trackUri) && item.status === 'submitting') {
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
