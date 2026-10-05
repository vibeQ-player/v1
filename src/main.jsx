import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import SearchBox from './SearchBox.jsx';

const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const imageUrl = value => value?.startsWith('/api/') ? `${API}${value}` : value;
let guestId = localStorage.getItem('vibeq-guest');
if (!guestId) { guestId = crypto.randomUUID(); localStorage.setItem('vibeq-guest', guestId); }
async function api(path, data, options = {}) {
  const token = sessionStorage.getItem('vibeq-host');
  const response = await fetch(`${API}/api${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: data === undefined ? undefined : JSON.stringify(data), signal: options.signal });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'Request failed.');
    error.retryAfter = Number(response.headers.get('retry-after')) || 0;
    if (response.status === 401 && path !== '/host/login') { sessionStorage.removeItem('vibeq-host'); window.dispatchEvent(new Event('host-expired')); }
    throw error;
  }
  return result;
}
const initial = { pending: [], queued: [], played: [], playback: {}, trivia: [], triviaFeed: [] };
const duration = ms => `${Math.floor((ms || 0) / 60000)}:${String(Math.floor((ms || 0) / 1000) % 60).padStart(2, '0')}`;
function Cover({ src, fallback, name, className = '' }) {
  return src ? <img className={`cover ${className}`} src={imageUrl(src)} alt={name ? `Artwork for ${name}` : ''} onError={e => { if (fallback && !e.currentTarget.dataset.fallbackUsed) { e.currentTarget.dataset.fallbackUsed = 'true'; e.currentTarget.src = imageUrl(fallback); } else e.currentTarget.style.visibility = 'hidden'; }} /> : <div className={`cover placeholder ${className}`} aria-hidden="true">♫</div>;
}
function AddonNotice({ kind, status }) {
  const label = kind === 'artwork' ? 'AI artwork' : 'Music trivia';
  const copy = {
    'waiting-playback': 'Add music to the room or start Spotify playback. Cached content appears when available.',
    'generating': 'Preparing content for the room’s music. It can take a minute or two.',
    'daily-limit': 'Today’s generation allowance has been reached. New content resumes at midnight UTC; cached songs remain available.',
    'unavailable': 'Content for this song is temporarily unavailable. The player will retry later.',
    'unconfigured': 'The host needs to configure a supported AI provider.'
  };
  return <section className="panel addon-card" role="status"><p className="eyebrow">{label}</p><p className="muted">{copy[status] || copy.generating}</p></section>;
}
function TrackRow({ item, index, action, actionLabel, remove }) {
  return <div className="track-row"><span className="index">{String(index + 1).padStart(2, '0')}</span><Cover src={item.customArt || item.albumArt} fallback={item.albumArt} name={item.trackName} className={item.customArt ? 'custom-cover' : ''} /><div className="track-text"><a href={item.spotifyUrl} target="_blank" rel="noreferrer">{item.trackName}</a><span>{item.artist}</span></div><span className="duration">{duration(item.durationMs)}</span>{action && <button className="small" onClick={() => action(item)} aria-label={`${actionLabel} ${item.trackName}`}>{actionLabel}</button>}{remove && <button className="small quiet" onClick={() => remove(item)} aria-label={`Remove ${item.trackName}`}>×</button>}</div>;
}
function TriviaCards({ facts }) {
  const [index, setIndex] = useState(0), [paused, setPaused] = useState(false), [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (paused || facts.length < 2) return;
    const timer = setInterval(() => setIndex(i => i + 1), 30000);
    return () => clearInterval(timer);
  }, [paused, facts.length, epoch]);
  if (!facts.length) return null;
  const slot = ((index % facts.length) + facts.length) % facts.length, fact = facts[slot];
  const step = delta => { setIndex(i => i + delta); setEpoch(e => e + 1); };
  return <section className="panel trivia"><div className="section-heading"><p className="eyebrow">{fact.kind === 'myth' ? 'MYTH, CORRECTED' : 'MUSIC FACT'}</p><div className="fact-controls"><button className="quiet" onClick={() => step(-1)} disabled={facts.length < 2} aria-label="Previous fact">‹</button><span>{slot + 1}/{facts.length}</span><button className="quiet" onClick={() => step(1)} disabled={facts.length < 2} aria-label="Next fact">›</button></div></div><div className="fact-subject"><Cover src={fact.customArt || fact.albumArt} fallback={fact.albumArt} name={fact.trackName} className={fact.customArt ? 'custom-cover' : ''} /><div><strong>{fact.trackName}</strong><span>{fact.artist}</span></div></div><p className="fact-text">{fact.text}</p><div className="sources">{fact.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a>)}</div><div className="fact-footer"><span className="muted">AI-researched · sources linked</span>{facts.length > 1 && <button className="quiet" onClick={() => setPaused(p => !p)}>{paused ? 'Resume trivia' : 'Pause trivia'}</button>}</div></section>;
}
function App() {
  const [settings, setSettings] = useState(null), [state, setState] = useState(initial);
  const [tab, setTab] = useState('queue');
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [hostPanel, setHostPanel] = useState(false), [host, setHost] = useState(Boolean(sessionStorage.getItem('vibeq-host'))), [password, setPassword] = useState('');
  const [devices, setDevices] = useState([]), [device, setDevice] = useState(''), [volume, setVolume] = useState(50);
  const [archives, setArchives] = useState([]), [archive, setArchive] = useState(null), [setName, setSetName] = useState('');
  const [votes, setVotes] = useState(() => JSON.parse(localStorage.getItem('vibeq-votes') || '[]'));
  const [browserStatus, setBrowserStatus] = useState(''), playerRef = useRef(null);
  const refresh = useCallback(async () => { setState(await api('/state')); }, []);
  useEffect(() => {
    let stopped = false, timer;
    async function poll() {
      try {
        const result = await api('/state');
        if (!stopped) setState(result);
      } catch (e) { if (!stopped) setError(e.message); }
      if (!stopped) timer = setTimeout(poll, document.hidden ? 30000 : 10000);
    }
    api('/config').then(setSettings).catch(e => setError(e.message)); poll();
    const expired = () => { setHost(false); playerRef.current?.disconnect(); playerRef.current = null; setBrowserStatus(''); };
    window.addEventListener('host-expired', expired);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('host-expired', expired); playerRef.current?.disconnect(); };
  }, []);
  async function run(work, success) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { const result = await work(); if (success) setMessage(typeof success === 'function' ? success(result) : success); await refresh(); return result; }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function addTrack(item) {
    return run(async () => {
      const result = await api('/requests', { trackUri: item.trackUri, guestId });
      const next = [...votes, result.request.id];
      setVotes(next); localStorage.setItem('vibeq-votes', JSON.stringify(next));
      return result;
    }, 'Added to the mix.');
  }
  async function vote(item) {
    const remove = votes.includes(item.id);
    await run(async () => {
      await api('/votes', { id: item.id, guestId, remove });
      const next = remove ? votes.filter(id => id !== item.id) : [...votes, item.id];
      setVotes(next); localStorage.setItem('vibeq-votes', JSON.stringify(next));
    });
  }
  async function login(e) {
    e.preventDefault();
    await run(async () => { const { token } = await api('/host/login', { password }); sessionStorage.setItem('vibeq-host', token); setHost(true); setPassword(''); }, 'Host controls unlocked.');
  }
  async function loadArchives() { setArchives((await api('/archives')).archives); }
  async function browserPlayer() {
    await run(async () => {
      if (playerRef.current) { setMessage('Browser player is already connected.'); return; }
      setBrowserStatus('Connecting…');
      if (!window.Spotify) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Spotify SDK did not load.')), 15000);
          window.onSpotifyWebPlaybackSDKReady = () => { clearTimeout(timeout); resolve(); };
          const script = document.createElement('script'); script.src = 'https://sdk.scdn.co/spotify-player.js';
          script.onerror = () => { clearTimeout(timeout); reject(new Error('Spotify SDK could not be loaded.')); };
          document.head.appendChild(script);
        });
      }
      const player = new window.Spotify.Player({ name: 'vibeQ browser', volume: 0.5, getOAuthToken: callback => api('/spotify/token').then(result => callback(result.accessToken)).catch(e => setError(e.message)) });
      playerRef.current = player;
      for (const name of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) player.addListener(name, ({ message }) => { setError(message); setBrowserStatus('Unavailable'); });
      player.addListener('ready', ({ device_id }) => { setDevice(device_id); setBrowserStatus('Ready · select transfer to play here'); });
      player.addListener('not_ready', () => setBrowserStatus('Offline'));
      await player.activateElement();
      if (!(await player.connect())) { playerRef.current = null; throw new Error('Could not connect browser playback.'); }
    });
  }
  async function saveSet(e) {
    e.preventDefault();
    if (!host) { setHostPanel(true); setMessage('Unlock host controls to save this set.'); requestAnimationFrame(() => document.getElementById('host-controls')?.scrollIntoView({ behavior: 'smooth' })); return; }
    await run(async () => {
      const { archive: saved } = await api('/archives', { name: setName });
      setArchive((await api(`/archives?id=${encodeURIComponent(saved.id)}`)).archive);
      await loadArchives(); setSetName(''); setTab('archives');
      return saved;
    }, saved => `Saved ${saved.tracks.length} tracks as “${saved.name}”.`);
  }
  const now = state.playback.track;
  const facts = state.triviaFeed || state.trivia;
  const completed = state.played.filter(song => song.status === 'played').length;
  return <div className="app"><header className="topbar"><a className="brand" href="/">vibe<span>Q</span><span className="brand-cursor" aria-hidden="true" /></a><div className="top-right"><span className={`status ${state.connected ? 'online' : ''}`} title={state.connected ? "The host’s Spotify account is linked to this room. See Now playing for playback and device status." : "The host needs to link a Spotify account before the room can search or request tracks."}><i />{state.connected ? 'Spotify linked' : 'Waiting for host'}</span><button className="quiet" onClick={() => setHostPanel(!hostPanel)}>Host controls {hostPanel ? '−' : '+'}</button></div></header>
    <main><section className="intro"><div><p className="eyebrow">ONE ROOM. EVERYONE’S SOUND.</p><h1>Your crowd.<br /><span>Your soundtrack.</span></h1><p className="lede">Find your next favourite. Add it to the mix.<br />Let the room decide what plays next.</p></div><div className="intro-meta"><span className="big-number">{String(state.pending.length + state.queued.length).padStart(2, '0')}</span><span>tracks in the mix</span><span className="pill">Fair play, all night</span></div></section>
    <div className="notice" role="status" aria-live="polite">{error ? <span className="error">{error}</span> : message}</div>
    {hostPanel && <section id="host-controls" className="panel host-panel"><div className="section-heading"><h2>Host controls</h2>{host && <button className="quiet" onClick={() => { sessionStorage.removeItem('vibeq-host'); setHost(false); playerRef.current?.disconnect(); playerRef.current = null; setBrowserStatus(''); }}>Sign out</button>}</div><p className="host-help">Link Spotify and manage the room’s queue. Playback controls act on your selected Spotify device; audio plays there.</p>{!host ? <form className="inline-form" onSubmit={login}><label className="sr-only" htmlFor="password">Host password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Host password" required /><button disabled={busy}>Unlock controls</button></form> : <><div className="controls"><button disabled={busy || !settings?.configured.spotify} onClick={() => run(async () => { const { url } = await api('/spotify/connect', {}); window.location.assign(url); })}>{state.connected ? 'Reconnect Spotify' : 'Connect Spotify'}</button>{['previous', 'play', 'pause', 'next'].map(command => <button className="secondary" key={command} disabled={busy || !state.connected} onClick={() => run(() => api('/spotify/control', { command }))}>{command}</button>)}</div><div className="device-controls"><button className="secondary" disabled={busy || !state.connected} onClick={() => run(async () => setDevices((await api('/spotify/devices')).devices || []))}>Find devices</button><label className="sr-only" htmlFor="device">Playback device</label><select id="device" value={device} onChange={e => setDevice(e.target.value)}><option value="">Choose a Spotify device</option>{devices.map(d => <option key={d.id} value={d.id}>{d.name}{d.is_active ? ' · active' : ''}</option>)}{device && !devices.some(d => d.id === device) && <option value={device}>vibeQ browser</option>}</select><button disabled={busy || !device} onClick={() => run(() => api('/spotify/control', { command: 'transfer', deviceId: device }), 'Playback transferred.')}>Transfer</button><label htmlFor="volume">Volume {volume}%</label><input id="volume" type="range" min="0" max="100" value={volume} onChange={e => setVolume(Number(e.target.value))} /><button className="secondary" disabled={busy || !state.connected} onClick={() => run(() => api('/spotify/control', { command: 'volume', volume, deviceId: device }))}>Set volume</button></div>{settings?.features.browserPlayer && <div className="controls"><button disabled={busy || !state.connected} onClick={browserPlayer}>Enable browser audio</button><span>{browserStatus || 'Spotify Premium required'}</span></div>}{!settings?.configured.spotify && <p>Set Spotify credentials in the server configuration to connect.</p>}</>}</section>}
    <div className="layout"><aside><section className="now-card"><div className="section-heading"><p className="eyebrow">{state.playback.isPlaying ? 'ON THE AIR' : 'NOW PLAYING'}</p><span className="sound-bars" aria-hidden="true">▂ ▆ ▃ ▇</span></div><Cover src={state.customArt || now?.albumArt} fallback={now?.albumArt} name={now?.trackName} className={`now-cover ${state.customArt ? 'custom-cover' : ''}`} />{state.customArt && <span className="art-label">Original vibeQ artwork</span>}<h2>{now?.trackName || 'The room is yours.'}</h2><p>{now?.artist || (state.connected ? 'Open Spotify on a device and start a track.' : 'Connect Spotify to start the soundtrack.')}</p>{now && <a className="spotify-link" href={now.spotifyUrl} target="_blank" rel="noreferrer">Listen on Spotify ↗</a>}<div className="now-footer"><span>{state.playback.deviceName || 'No active device'}</span><span>{state.playback.isPlaying ? 'Playing' : 'Standby'}</span></div></section>
    {settings?.features.artwork && !state.customArt && <AddonNotice kind="artwork" status={state.addonStatus?.artwork} />}
    {settings?.features.trivia && !facts.length && <AddonNotice kind="trivia" status={state.addonStatus?.trivia} />}
    {settings?.features.trivia && facts.length > 0 && <TriviaCards facts={facts} />}
    <section className="fair-note"><span>↗</span><div><h3>A little democracy.<br />A lot of good music.</h3><p>Votes lift your favourites. Fair queueing gives everyone a turn. Tracks already sent to Spotify keep their order.</p></div></section></aside>
    <section className="queue-area"><SearchBox connected={state.connected} searchTracks={(query, signal) => api(`/search?q=${encodeURIComponent(query)}`, undefined, { signal })} onAdd={addTrack} busy={busy} queuedUris={[...state.pending, ...state.queued].map(item => item.trackUri)} /><nav className="tabs" aria-label="Player views">{[['queue', 'The queue'], ['played', 'Played'], ...(settings?.features.archives ? [['archives', 'Saved sets']] : [])].map(([value,label]) => <button key={value} aria-current={tab === value ? 'page' : undefined} className={tab === value ? 'active' : ''} onClick={() => { setTab(value); if (value === 'archives') run(loadArchives); }}>{label}{value === 'queue' && <span>{state.pending.length}</span>}</button>)}</nav>
    {tab === 'queue' && <><div className="section-heading queue-title"><h2>Up next</h2><span className="muted">Chosen by the room</span></div>{state.queued.length > 0 && <div className="buffer"><p className="eyebrow">LOCKED IN · SENT TO SPOTIFY</p>{state.queued.map((item,i) => <TrackRow key={item.id} item={item} index={i} />)}</div>}<div className="pending">{state.pending.map((item,i) => <div key={item.id} className={i === 0 ? 'next-track' : ''}><TrackRow item={item} index={i} action={vote} actionLabel={`${votes.includes(item.id) ? '✓' : '↑'} ${item.votes}`} remove={host ? item => run(() => api('/requests/delete', { id: item.id })) : undefined} /></div>)}</div>{!state.pending.length && <div className="empty"><span>＋</span><h3>Make the first move.</h3><p>Search for a track and give this room its next favourite.</p></div>}</>}
    {tab === 'played' && <><div className="section-heading queue-title"><h2>The soundtrack so far</h2><span className="muted">This session</span></div>{state.played.map((item,i) => <TrackRow key={item.id} item={item} index={i} />)}{!state.played.length && <div className="empty"><h3>Good memories start here.</h3><p>Requested tracks appear as playback is observed.</p></div>}{settings?.features.archives && <form className="inline-form archive-form" onSubmit={saveSet}><label className="sr-only" htmlFor="setName">Set name</label><input id="setName" value={setName} onChange={e => setSetName(e.target.value)} placeholder="Name this set (optional)" maxLength={100} /><button disabled={busy || !completed}>Save set</button><p className="muted archive-help">{completed ? `${completed} completed tracks. ${host ? 'Save to the archive without changing the fair queue.' : 'Host sign-in is required to save.'}` : 'Tracks can be saved once they finish playing.'}</p></form>}</>}
    {tab === 'archives' && <><div className="section-heading queue-title"><h2>Worth another listen.</h2><span className="muted">Saved sets</span></div>{archives.map(item => <button className="archive-row" key={item.id} onClick={() => run(async () => setArchive((await api(`/archives?id=${encodeURIComponent(item.id)}`)).archive))}><span><strong>{item.name}</strong><small>{new Date(item.savedAt).toLocaleDateString()}</small></span><span>{item.trackCount} tracks ↗</span></button>)}{!archives.length && <div className="empty"><h3>Keep the good nights.</h3><p>Save a set from Played. The host can replay it, and anyone can browse it or copy its Spotify URIs.</p></div>}{archive && <section className="archive-detail"><div className="section-heading"><h3>{archive.name}</h3><button className="quiet" onClick={() => setArchive(null)}>Close</button></div><div className="controls"><button className="secondary" onClick={() => run(() => navigator.clipboard.writeText(archive.tracks.map(t => t.trackUri).join('\n')), 'Spotify URIs copied.')}>Copy Spotify URIs</button>{host && <button disabled={busy} onClick={() => run(() => api('/archives/replay', { id: archive.id }), result => `${result.added} tracks returned to the fair queue.`)}>Replay set</button>}</div>{archive.tracks.map((item,i) => <TrackRow key={item.id} item={item} index={i} />)}</section>}</>}
    </section></div></main><footer><span className="brand">vibe<span>Q</span><span className="brand-cursor" aria-hidden="true" /></span><span>Good music. Shared.</span><a href="https://developer.spotify.com/" target="_blank" rel="noreferrer">Powered by Spotify</a></footer></div>;
}
createRoot(document.getElementById('root')).render(<App />);
