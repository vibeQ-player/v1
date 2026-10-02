# vibeQ — a Spotify jukebox for everyone in the room

Search Spotify, request songs, vote for favourites, and let a fair queue give everyone a turn. Hosts connect one Spotify account and manage playback. Optional session archives, original AI artwork, and sourced trivia enhance the experience.

**Run locally with Node.js and SQLite: no Azure account, Azure Functions, Docker, or AI credentials required.** The same application services also run on Azure for a hosted demo. YouTube, bookings, and multiple Spotify account slots are outside this project’s scope.

## Features

- Spotify search, anonymous requests, voting, and weighted fair queueing.
- Host sign-in, Spotify authorization, play/pause/skip, devices, and volume.
- Independent background queue advancement while guest tabs are closed.
- Optional archives: save completed requests, export Spotify URIs, and replay sessions.
- Optional artwork: original AI interpretations, displayed separately from Spotify album art.
- Optional trivia: web-researched prose with clickable source citations.
- Optional Spotify Web Playback SDK audio in the host’s browser.

Normally music plays on a Spotify Connect device, such as Spotify’s desktop app. The browser controls that device; it does not download music. Browser audio is an explicit optional setting.

## Requirements

- Node.js **22.13+** (22 or 24) and npm.
- A Spotify developer application with its client ID and secret.
- A Spotify Premium host account for playback controls/browser audio, with access to the developer app.
- Internet access to Spotify. Local hosting does not mean offline playback.

Review [Spotify’s current quota-mode requirements](https://developer.spotify.com/documentation/web-api/concepts/quota-modes). A public website does not grant arbitrary visitors Spotify OAuth access. Development-mode restrictions apply to connecting accounts. Guests here request/vote using the host’s connection; they do not authorize their own accounts.

## Run locally

```powershell
git clone https://github.com/vibeQ-player/v1.git
cd v1
npm ci
Copy-Item .env.example .env
```

On macOS/Linux use `cp .env.example .env`. The npm commands work on either platform.

Generate **two different** random secrets by running this twice:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Edit `.env`:

```dotenv
SPOTIFY_CLIENT_ID=your-client-id
SPOTIFY_CLIENT_SECRET=your-client-secret
HOST_PASSWORD=one-generated-secret
SESSION_SECRET=the-other-generated-secret
```

The password must contain at least 12 characters; the signing secret at least 32. `.env`, SQLite data, generated images, and deployment packages are ignored by Git. Never put secrets in `VITE_*` settings: those are embedded in the public frontend.

In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), register this exact redirect URI:

```text
http://127.0.0.1:5173/api/spotify/callback
```

Spotify requires explicit loopback IPs for HTTP redirects: `localhost` is not permitted. Hosted redirects must use HTTPS and match exactly. [Redirect documentation](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)

```powershell
npm run dev
```

Open **http://127.0.0.1:5173**. Unlock **Host controls** using your password, then **Connect Spotify**. Approve access. Open Spotify on the host playback device and start a song. Use **Find devices** and **Transfer** if needed. Guests can search, request, and vote.

Vite proxies `/api` to the local Node server on port 3001. No Functions Core Tools are required. Run one local API instance per database. Queue advancement runs every 15 seconds; the visible UI normally polls every 10 seconds.

### Run a production build locally

Change `.env` and register the new Spotify redirect:

```dotenv
APP_ORIGIN=http://127.0.0.1:3001
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3001/api/spotify/callback
```

```powershell
npm run build
npm start
```

Open **http://127.0.0.1:3001**. Restore both settings to port 5173 for Vite development. Keep `PORT=3001` unless you also edit the Vite proxy. The local server binds to loopback; LAN/public hosting requires an HTTPS reverse proxy and matching origin settings.

## Optional add-ons

| Setting | Default | Requirements |
| --- | --- | --- |
| `ENABLE_ARCHIVES` | `true` | SQLite or Cosmos only |
| `ENABLE_ARTWORK` | `false` | Compatible image model/provider; cloud storage in Azure mode |
| `ENABLE_TRIVIA` | `false` | Responses API model with web search and source annotations |
| `ENABLE_BROWSER_PLAYER` | `false` | Spotify Premium and additional OAuth scopes |

Use literal `true`/`false` and restart the server after changes. Reconnect Spotify when enabling browser playback. Click **Enable browser audio**, then **Transfer** to its device. Browser/device support and volume restrictions depend on Spotify.

### Archives

The host saves completed requested tracks from **Played**, with an optional session name. Visitors view saved sessions; the host can replay them into the fair queue. Replay skips tracks already active. **Copy Spotify URIs** provides manual export; automatic Spotify playlist creation is not implemented.

Only playback witnessed by the worker enters completed history. Skipped/unobserved songs may be absent. Archives preserve the two-hour fairness history. Archive names/tracks are public to visitors; do not include private information.

### Artwork and trivia providers

The runtime supports configurable compatible providers. Neither add-on requires Azure locally:

```dotenv
AI_BASE_URL=https://api.openai.com/v1
AI_AUTH_HEADER=Authorization
AI_API_KEY=your-provider-key
AI_IMAGE_MODEL=your-supported-image-model
AI_TRIVIA_MODEL=your-supported-web-search-model
ENABLE_ARTWORK=true
ENABLE_TRIVIA=true
ADDON_DAILY_LIMIT=10
```

For Azure OpenAI:

```dotenv
AI_BASE_URL=https://YOUR-RESOURCE.openai.azure.com/openai/v1
AI_AUTH_HEADER=api-key
AI_API_KEY=your-azure-key
AI_IMAGE_MODEL=your-image-deployment-name
AI_TRIVIA_MODEL=your-web-search-capable-deployment-name
```

Artwork uses `POST /images/generations`, requiring base64 PNG output, `size=1024x1024`, and `quality=low`. Trivia uses `POST /responses` with the `web_search` tool. **Not every compatible provider or Azure model deployment supports these endpoints/features.** Configure models explicitly and verify provider support. Models are not provisioned by this repository’s deployment script.

Images are stored in `data/artwork/` locally. Cosmos mode needs `ARTWORK_STORAGE_CONNECTION_STRING`; deployment creates a private `artwork` Blob container when enabled. The API serves images without exposing storage credentials. Spotify album art remains visible separately.

Trivia is published only when provider source annotations are present. Citations do not guarantee accuracy. Failed generation keeps the player usable and retries no sooner than one hour later. One track is processed per minute, capped at ten new tracks per UTC day by default. Each processed track can make two provider calls (one per enabled add-on). Failed attempts count toward the limit. Set provider spending limits separately; `ADDON_DAILY_LIMIT=0` stops new generation while retaining cached content.

Provider references: [Image generation](https://developers.openai.com/api/docs/guides/image-generation), [web search](https://developers.openai.com/api/docs/guides/tools-web-search), [Azure/OpenAI endpoint differences](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/switching-endpoints).

## Deploy an Azure demo

Local users can skip this section.

Architecture: **Azure Static Web Apps Free** frontend, a separate **Azure Functions Flex Consumption** backend, **Cosmos DB NoSQL serverless**, Functions Storage, and Application Insights. The frontend calls the backend’s HTTPS URL using restricted CORS. Functions runs both HTTP handlers and timers; it shares the local implementation.

We use a separate Function app because Static Web Apps managed APIs support HTTP triggers only. [Microsoft API comparison](https://learn.microsoft.com/en-us/azure/static-web-apps/apis-functions)

### Prerequisites and deployment

- PowerShell 7 (`pwsh`), Node/npm, Git, and Azure CLI **2.60+**.
- An Azure subscription with permission to create resources/register providers.
- A region supporting Flex Consumption and Cosmos serverless.
- A configured `.env` with your own Spotify and host credentials.

The script uses **Azure CLI** for infrastructure/settings/Functions deployment, and the separate **Static Web Apps CLI** for frontend upload. SWA CLI is downloaded via `npx`. Neither Functions Core Tools nor Azure Developer CLI (`azd`) is required.

```powershell
az login
az account list --query "[].{Name:name,Id:id}" -o table
az account set --subscription YOUR_SUBSCRIPTION_ID
az functionapp list-flexconsumption-locations -o table
pwsh -File scripts/deploy.ps1 -ResourceGroup rg-vibeq-demo -NamePrefix YOUR_UNIQUE_PREFIX -Location eastus2
```

Replace `YOUR_UNIQUE_PREFIX` with a globally unique name of 4–16 lowercase letters/digits starting with a letter. Run from the repository root. The script creates a dedicated resource group, Storage, Node 22/512 MB Function app, Cosmos account/database/container, and Static Web App. It runs tests, packages the shared backend, performs a Linux remote build, then builds/publishes the frontend with its API URL.

Secrets are passed through a temporary ignored JSON file removed afterwards. URLs/identifiers are saved in ignored `.deploy/demo.json`. The default deployment enables archives and disables AI/browser playback. Configure provider/add-on settings in `.env` before deployment to enable them.

### Connect and verify

1. Register the exact **Spotify redirect URI** printed by the deployment script in the Spotify developer app. Keep local redirects if you still need them.
2. Open the printed demo URL. Unlock Host controls with the `.env` password and connect Spotify.
3. Start Spotify on the host’s playback device; select/transfer it if necessary.
4. Search, request, and vote. Allow up to 15 seconds for the worker to append a song.
5. Close guest tabs and verify playback continues on the host device. Closing the browser audio player’s own tab stops that device.

```powershell
Invoke-RestMethod https://YOUR_FUNCTION_HOST/api/health
Invoke-RestMethod https://YOUR_FUNCTION_HOST/api/config
az functionapp function list --name YOUR_PREFIX-api --resource-group rg-vibeq-demo --query "[].name" -o table
```

Inspect worker errors in the Function app’s Application Insights logs. Do not log passwords, tokens, or full configuration. `/health` verifies HTTP availability, not end-to-end playback.

### Updates and cleanup

```powershell
pwsh -File scripts/deploy.ps1 -ResourceGroup rg-vibeq-demo -NamePrefix YOUR_UNIQUE_PREFIX -Location eastus2 -UpdateOnly
```

Updates apply current `.env` add-on settings. Provisioning can be rerun with the same identifiers after partial failure; keep existing resource locations. Use dedicated demo resources because deployment updates app settings and code.

Review the group before deleting. Cleanup removes its database, archives, and all resources:

```powershell
az resource list --resource-group rg-vibeq-demo --query "[].{Name:name,Type:type}" -o table
az group delete --name rg-vibeq-demo
```

### Costs and official documentation

SWA uses its Free plan. Functions/timers, Cosmos operations, Storage, and Application Insights may incur charges even with no visitors. AI adds provider charges. No always-ready instances are configured; the maximum Functions instance count of 40 is **not a spending cap**. Set Azure/provider budgets and remove demo resources when finished.

- [Functions Flex Consumption and Azure CLI deployment](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-how-to)
- [Functions Node programming model v4](https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-node)
- [Static Web Apps CLI deployment](https://learn.microsoft.com/en-us/azure/static-web-apps/static-web-apps-cli-deploy)

## Configuration and operation

`.env.example` lists local settings. Azure settings are generated from it during deployment.

| Variable | Purpose |
| --- | --- |
| `HOST_PASSWORD`, `SESSION_SECRET` | Host login and signed eight-hour bearer sessions |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Server-side OAuth credentials |
| `APP_ORIGIN` | Exact frontend origin, no trailing slash |
| `SPOTIFY_REDIRECT_URI` | Callback ending in `/api/spotify/callback` |
| `PORT`, `DATA_DIR` | Local API port and SQLite/artwork directory |
| `STORAGE_DRIVER` | `sqlite` locally; `cosmos` in Azure |
| `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DATABASE` | Cosmos adapter configuration |
| `ARTWORK_STORAGE_CONNECTION_STRING` | Private cloud artwork storage |
| `ENABLE_*`, `AI_*`, `ADDON_DAILY_LIMIT` | Optional features/provider configuration described above |
| `VITE_API_BASE_URL` | Public backend origin for cloud builds; unset locally |

Host bearer sessions live in browser session storage. Changing `SESSION_SECRET` invalidates sessions; changing the password alone does not. Spotify refresh tokens stay in the backend database. Keep local `data/` private and back it up. Cloud access currently uses keys protected by Azure access controls; managed identity can be added through a storage adapter later.

Fair scoring uses `cost = 1 / (votes + 1)` accumulated per guest across pending/buffered songs and observed plays in the last two hours. Lower scores play first. Votes reorder pending requests, not the three tracks already sent to Spotify. Recent archived plays still contribute.

Queue/vote updates use compare-and-swap writes and worker leases. Ambiguous Spotify POST timeouts are recorded rather than blindly retried, preventing duplicate submission. Missing buffered tracks are reconciled after three minutes while playback is active; skipped/unobserved tracks are excluded from archives.

Guest IDs can be reset/spoofed. Request limits constrain casual spam but are not strong public-service identity/abuse protection. Account connection, playback/device controls, removal, archive saving/replay, and SDK tokens require host sign-in. Search, requests, votes, archive reads, and artwork reads are public.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Server fails at startup | Host/session secrets and Node 22.13+ |
| Redirect rejected | Exact scheme/host/port/path; use `127.0.0.1`, not `localhost` |
| Spotify 403 | Premium, app access/quota mode, scopes; reconnect after changing scopes |
| No device/queue stalled | Start Spotify, find/transfer a device, examine worker logs |
| Origin not allowed | Match `APP_ORIGIN` to the browser URL; 5173 versus 3001 |
| Rate limiting | Wait for Spotify `Retry-After`; shared cooldown prevents repeated calls |
| AI content absent | Flags, provider capabilities/key, daily limit, retry cooldown, cloud Blob container |
| Azure routes missing | Package root `host.json`, deployment logs, three registered functions |
| No archive tracks | Save completed requested tracks; external Spotify tracks are not archived |

## Development and portability

```powershell
npm run check
```

This runs backend syntax checks, storage/auth/queue regression tests, and the frontend build. GitHub Actions checks Node 22 and 24. Automated tests use temporary SQLite databases and fake Spotify responses. Real Spotify playback and AI compatibility require configured accounts/providers.

```text
src/                    React UI and optional browser playback
server/app.js           Shared HTTP application
server/spotify.js       Spotify API and refresh handling
server/queue.js          Independent queue worker
server/fair-queue.cjs    Extracted weighted fairness algorithm
server/store.js          SQLite/Cosmos adapters and leases
server/addons.js         Artwork/trivia providers and cache
server/local.js          Local Node server and timers
api/functions.js        Thin Azure HTTP/timer wrappers
scripts/deploy.ps1      Azure CLI/SWA CLI deployment
test/                   Offline regression tests
```

`npm run functions:prepare` copies shared code into ignored `.deploy/api/`. Node local mode never loads Azure dependencies. Optional Functions-wrapper development requires Core Tools v4/Azurite: run `npm ci --prefix api`, prepare the package, install dependencies in `.deploy/api`, copy `api/local.settings.example.json` to `.deploy/api/local.settings.json`, fill secrets, start Azurite, then run `func start --script-root .deploy/api --port 3001`. Use Vite separately and stop the local Node API first. Secret settings are excluded from deployment ZIPs.

Cosmos uses one `documents` container partitioned by `/collection`: `requests`, `archives`, `system`, `oauth`, `limits`, `locks`, and `addons`. SQLite stores equivalent documents in one table. Cosmos default TTL is disabled (`-1`), with per-item expiry for OAuth/limit records. Local data has no automatic retention; backups and history/cache maintenance are the operator’s responsibility.

Other hosts can wrap the shared Request/Response handler and schedule its workers. Other databases implement `get/list/put` with version-checked writes. This repository embeds no original deployment’s resource names or credentials.

## License

MIT; see [LICENSE](LICENSE). The weighted fair-queue algorithm is adapted from the original vibeQ by groovepop, with attribution retained. Spotify content belongs to its rights holders; this project is not affiliated with Spotify.
"# v1" 
