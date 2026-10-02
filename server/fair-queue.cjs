// api/lib/fair-queue.js
// Weighted-fair-queueing score — the party version of F = max(V, F_prev) + L/w.
//
// Every request costs L/w, with L = 1 (songs are one unit) and w = votes + 1,
// so voted-up songs are "lighter" and finish sooner. A guest's score
// accumulates across their recent plays (2h window), their songs sitting in
// the Spotify buffer, and their own earlier pending requests — so a burst of
// requests drifts later and later, but votes smoothly pull a song forward.
// LOWEST score plays next.
//
// Within one guest, their most-voted pending song takes their earliest slot
// (k = position in the guest's vote-ranked line, not raw arrival order).
//
// Stateless by design: recomputed from the requests container on every call.
// No new fields are written to the database.

const FAIRNESS_WINDOW_MS = 2 * 60 * 60 * 1000;

function fairSortPending(allRequests, now = Date.now()) {
  const cutoff = now - FAIRNESS_WINDOW_MS;
  const cost = (r) => 1 / ((r.votes || 0) + 1);

  // phase 0 = already played (in window), 1 = in the Spotify buffer, 2 = pending
  const phase = (r) => (r.status === 'played' ? 0 : r.status === 'queued' ? 1 : 2);
  const phaseTime = (r) =>
    new Date((r.status === 'played' ? r.playedAt : r.status === 'queued' ? r.queuedAt : r.createdAt) || 0).getTime();

  const byGuest = {};
  for (const r of allRequests) {
    const counts = r.status === 'pending' || r.status === 'queued' ||
      (r.status === 'played' && r.playedAt && new Date(r.playedAt).getTime() >= cutoff);
    if (!counts) continue;
    const gid = r.guestId || 'host';
    (byGuest[gid] = byGuest[gid] || []).push(r);
  }

  const scoreOf = {};
  for (const gid of Object.keys(byGuest)) {
    byGuest[gid].sort((a, b) => {
      if (phase(a) !== phase(b)) return phase(a) - phase(b);
      if (phase(a) === 2 && (b.votes || 0) !== (a.votes || 0)) return (b.votes || 0) - (a.votes || 0);
      const t = phaseTime(a) - phaseTime(b);
      if (t !== 0) return t;
      return String(a.id).localeCompare(String(b.id));
    });
    let f = 0;
    for (const r of byGuest[gid]) {
      f += cost(r);
      if (r.status === 'pending') scoreOf[r.id] = f;
    }
  }

  const sorted = allRequests.filter(r => r.status === 'pending').sort((a, b) => {
    if (scoreOf[a.id] !== scoreOf[b.id]) return scoreOf[a.id] - scoreOf[b.id];
    if ((b.votes || 0) !== (a.votes || 0)) return (b.votes || 0) - (a.votes || 0);
    const ageDiff = new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    if (ageDiff !== 0) return ageDiff;
    return String(a.id).localeCompare(String(b.id));
  });

  return { sorted, scoreOf };
}

module.exports = { fairSortPending, FAIRNESS_WINDOW_MS };
