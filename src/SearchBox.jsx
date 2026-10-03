import React, { useEffect, useRef, useState } from 'react';

const length = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export default function SearchBox({ connected, searchTracks, onResults, onAdd, busy, queuedUris }) {
  const [query, setQuery] = useState(''), [tracks, setTracks] = useState([]);
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [active, setActive] = useState(-1);
  const input = useRef(null), options = useRef(null), cache = useRef(new Map());
  const cooldown = useRef(0), search = useRef(searchTracks);
  search.current = searchTracks;
  const term = query.trim();
  const expanded = open && term.length >= 2;

  useEffect(() => {
    setActive(-1); setError(''); setTracks([]);
    if (term.length < 2 || !connected) { setLoading(false); return; }
    const controller = new AbortController();
    const key = term.toLowerCase(), saved = cache.current.get(key);
    if (saved && Date.now() - saved.time < 60000) {
      setTracks(saved.tracks); setLoading(false); return;
    }
    if (Date.now() < cooldown.current) {
      setError('Spotify needs a moment. Please try again shortly.'); setLoading(false); return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await search.current(term, controller.signal);
        if (controller.signal.aborted) return;
        setTracks(result.tracks);
        if (cache.current.size >= 20) cache.current.delete(cache.current.keys().next().value);
        cache.current.set(key, { time: Date.now(), tracks: result.tracks });
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e.retryAfter) cooldown.current = Date.now() + e.retryAfter * 1000;
        setError(e.message);
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [term, connected]);

  useEffect(() => {
    if (active >= 0) options.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  async function add(item) {
    if (busy || queuedUris.includes(item.trackUri)) return;
    if (await onAdd(item)) { setOpen(false); setActive(-1); input.current?.focus(); setOpen(false); }
  }
  function showResults() {
    if (!loading && tracks.length) { onResults(tracks); setOpen(false); setActive(-1); }
  }
  function keyboard(e) {
    if (e.key === 'Escape') { setOpen(false); setActive(-1); return; }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && tracks.length) {
      e.preventDefault(); setOpen(true);
      setActive(previous => e.key === 'ArrowDown' ? (previous + 1) % tracks.length : (previous <= 0 ? tracks.length - 1 : previous - 1));
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (expanded && active >= 0 && tracks[active]) add(tracks[active]); else showResults();
    }
  }

  return <div className="search-shell" onBlur={e => {
    if (!e.currentTarget.contains(e.relatedTarget)) { setOpen(false); setActive(-1); }
  }}>
    <form className={`search ${expanded ? 'search-expanded' : ''}`} onSubmit={e => { e.preventDefault(); showResults(); }}>
      <label className="sr-only" htmlFor="search">Search Spotify tracks or artists</label>
      <span aria-hidden="true">⌕</span>
      <input ref={input} id="search" role="combobox" aria-autocomplete="list" aria-expanded={expanded}
        aria-controls={expanded ? 'search-options' : undefined} aria-activedescendant={expanded && active >= 0 ? `search-option-${active}` : undefined}
        aria-describedby="search-help" autoComplete="off" maxLength={100} value={query}
        onChange={e => { setQuery(e.target.value); setTracks([]); setActive(-1); setOpen(true); }}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={keyboard} placeholder="Search a song or artist…" />
      {query && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => { setQuery(''); setTracks([]); setOpen(false); input.current?.focus(); }}>×</button>}
      <button disabled={loading || !connected || !tracks.length}>View results ↗</button>
    </form>
    <span id="search-help" className="sr-only">Type at least two characters. Use arrow keys to select a track and Enter to add it. Escape closes results.</span>
    {expanded && <div className="search-dropdown">
      <div className="search-summary" role="status" aria-live="polite">
        {!connected ? 'The host needs to connect Spotify first.' : loading ? 'Searching Spotify…' : error || (tracks.length ? `${tracks.length} tracks · select to add to the mix` : `No tracks found for “${term}”. Try another song or artist.`)}
      </div>
      <div id="search-options" role="listbox" aria-label="Spotify search results" ref={options}>
        {!loading && !error && connected && tracks.map((item, index) => {
          const queued = queuedUris.includes(item.trackUri);
          return <button type="button" role="option" id={`search-option-${index}`} key={item.id}
            aria-selected={active === index} aria-disabled={busy || queued} aria-label={`${item.trackName} by ${item.artist}${queued ? ', already in the queue' : ', add to queue'}`}
            className={`search-option ${active === index ? 'selected' : ''}`} onClick={() => add(item)} onMouseMove={() => setActive(index)}>
            {item.albumArt ? <img className="cover" src={item.albumArt} alt="" /> : <span className="cover placeholder" aria-hidden="true">♫</span>}
            <span className="search-track"><strong>{item.trackName}</strong><span>{item.artist}</span></span>
            <span className="duration">{length(item.durationMs || 0)}</span><span className="search-add">{queued ? '✓ Queued' : busy ? '…' : '＋ Add'}</span>
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
