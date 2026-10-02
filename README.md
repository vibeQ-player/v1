# vibeQ

**A live, fair-play Spotify jukebox for parties and events.**

Anyone in the room can request a song and vote. No account required.
The **Fair Priority Score** algorithm ensures no single guest can dominate the queue — the more songs you request, the further back each new one lands, while votes from the crowd pull any track forward naturally.

> Live demo: [vibeq.app](https://vibeq.app)

---

## How the Fair Queue Works

vibeQ uses a **Weighted Fair Queueing** algorithm adapted for party dynamics, implemented in [`api/lib/fair-queue.js`](api/lib/fair-queue.js).

Each song request is assigned a **Fair Priority Score**:

```
cost(request) = 1 / (votes + 1)
score(guest)  = sum of costs across their recent requests
```

- A guest's score **accumulates** across all their pending requests and recently played songs (2-hour window)
- Each new request from the same guest lands further back — burst-requesters can't flood the queue
- **Votes pull songs forward** — a heavily voted track has a lower cost, reducing the guest's score and making it rise in the queue
- The algorithm is **stateless**: recomputed on every poll from the live database — no stored scores to drift out of sync

The result: a queue that feels fair to everyone in the room, rewards popular picks, and keeps any one person from spamming their way to the top.

A 3-song Spotify buffer is maintained at all times (via `spotify-queue-next.js`) so playback is always seamless.

---

## Tech Stack

| Layer | Stack |
|---|---|
| Frontend | React 19 + TypeScript + Vite |
| Styling | Vanilla CSS |
| Backend | Azure Functions (Node.js) |
| Database | Azure Cosmos DB (NoSQL) |
| Updates | Polling (3–5s) |
| Music | Spotify Web API + Web Playback SDK |
| Art gen | Azure OpenAI image generation (optional) |
| Hosting | Azure Static Web Apps |

---

## Features

- 🎵 **Spotify fair-play queue** — request, vote, watch the queue update live
- 🎨 **AI-generated track art** — custom artwork auto-generated per song (optional)
- 📖 **Song trivia cards** — rotating facts about queued and currently-playing tracks
- 🎛️ **Host dashboard** — now playing, queue management, device casting, volume, export playlist
- 📺 **TV mode** — big-screen display for the room
- 🎬 **Video Jukebox** — YouTube queue with the same fair-play algorithm
- 📦 **Set archive** — save and replay past sessions as Spotify playlists
- 🔒 **No login required** — guests get a persistent anonymous ID via localStorage

---

## Self-Hosting

### Prerequisites

- Node.js 20+
- [Azure Static Web Apps CLI](https://azure.github.io/static-web-apps-cli/) (`npm i -g @azure/static-web-apps-cli`)
- A [Spotify Developer App](https://developer.spotify.com/dashboard) with your redirect URI registered
- An [Azure Cosmos DB](https://portal.azure.com) account (NoSQL/Core API)

### 1. Clone and install

```bash
git clone https://github.com/groovepop/vibeq.git
cd vibeq
npm install
cd api && npm install && cd ..
```

### 2. Configure environment variables

```bash
cp api/.env.example api/local.settings.json
```

Edit `api/local.settings.json` and fill in all values. See [`api/.env.example`](api/.env.example) for the full list with descriptions.

The `local.settings.json` format for Azure Functions:
```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "SPOTIFY_CLIENT_ID": "...",
    "SPOTIFY_CLIENT_SECRET": "...",
    "COSMOS_ENDPOINT": "...",
    "COSMOS_KEY": "...",
    "COSMOS_DATABASE": "vibeq"
  }
}
```

### 3. Authorize Spotify

Register your callback URL in your Spotify Developer App:
```
http://localhost:4280/api/spotify-callback
```

Then authorize slot 1 (the default public room):
```
http://localhost:4280/api/spotify-authorize?slot=1
```

### 4. Run locally

```bash
swa start
```

The app runs at `http://localhost:4280`.

---

## Project Structure

```
vibeq/
├── src/
│   └── pages/
│       ├── LandingPublic.tsx    # Main Spotify jukebox (public room)
│       ├── RoomViewer.tsx       # Guest view of a private room
│       ├── RoomHost.tsx         # Host dashboard
│       ├── RoomTV.tsx           # Big-screen TV mode
│       ├── VideoJukebox.tsx     # YouTube queue
│       ├── Player.tsx           # Standalone YouTube player
│       ├── BookRoom.tsx         # Room booking flow
│       └── SetArchive.tsx       # Past set replay
└── api/
    ├── lib/
    │   ├── fair-queue.js        # ⭐ The WFQ algorithm
    │   ├── spotify-token.js     # OAuth token resolution by slot
    │   ├── cosmos-client.js     # Azure Cosmos DB client
    │   ├── image-generator.js   # AI track art generation
    │   └── fact-generator.js    # Song trivia generation
    ├── spotify-queue-next.js    # Fair queue → Spotify buffer
    ├── spotify-search.js        # Hybrid Spotify search
    ├── request-add.js           # Add a track request
    ├── request-vote.js          # Vote on a request
    ├── spotify-currently-playing.js
    └── ...                      # Full Spotify control surface
```

---

## Cosmos DB Schema

```
Database: vibeq

Container: system      (partition: /id)
  spotifyToken_1 … spotifyToken_5   ← OAuth tokens per slot

Container: rooms       (partition: /id)
  { id, name, spotifySlot, isPublic, spotifyConnected }

Container: requests    (partition: /roomId)
  { id, roomId, trackName, artist, trackUri, albumArt,
    votes, voters[], guestId, status, createdAt, playedAt }

Container: facts       (partition: /id)
  Cached AI-generated trivia per track

Container: trackArt    (partition: /id)
  Cached Azure Blob Storage URLs for generated artwork
```

---

## License

MIT — see [LICENSE](LICENSE)
"# v1" 
