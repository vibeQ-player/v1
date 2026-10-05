# Docker validation

## Workstation check (2026-10-05)

- Docker Desktop 4.93.0, engine/CLI 29.8.1 and Compose 5.5.1 verified; Linux amd64 engine responding.
- Initial setup was blocked by old WSL and a missing kernel. After the user repaired WSL, version 3.0.1 with kernel 6.18.40.1-1 reports `docker-desktop` running under WSL 2.
- Clean build passed using `docker build --pull --no-cache --platform linux/amd64 -t vibeq:local .`. A subsequent build with package version 1.0.1 also passed. Node 24.21.0 builds the frontend successfully inside Linux; the earlier Windows Vite stall did not recur there.
- All 20 application tests passed under Linux Node 24, covering mocked Spotify/auth/search/playback, voting, FPQS, archives and add-ons. The original 17 also passed on Windows before its frontend build stalled.
- Container smoke tests passed on both builds: non-root UID 1000, clean initial data, artwork seed present, no development dependencies, homepage/player HTTP, host login, OAuth callback URL, voting, FPQS state, saved set, replacement persistence, restart, healthcheck and graceful shutdown with exit code 0.
- Compose configuration and `git diff --check` passed. The local Compose service reports healthy and publishes only `127.0.0.1:3001`.
- Browser inspection confirmed that the player renders and uses the local API.
- Separate live provider tests passed using disposable containers/sample song metadata: artwork generated, stored and retrieved a valid 763,356-byte PNG; trivia returned six sourced items cached in SQLite. These used `/tmp` storage, not the room's persistent data.
- A scan of 107 runtime files found no configured secret values and no Azure Function API URL in built JavaScript. `.env.docker` is ignored by Git and excluded from the image.
- Live Spotify authorization and search passed. Observed a requested song transition from playing to completed history and the next request start playing. A named validation set was saved from real completed history. Device listing and a volume command preserving the current volume passed; Spotify rejected a resume command while already playing.
- Live testing exposed successful command responses containing opaque non-JSON acknowledgements. Fixed playback commands to accept successful 2xx responses without JSON parsing. Playback observation now precedes queue reads, records transitions even when the new track is paused, preserves history across queue-read failures, and matches Spotify's relinked track URI. Regression tests cover these cases; the rebuilt image and container smoke tests passed.
- Songs played or skipped entirely between worker polls cannot be reconstructed from current playback. Previously unobserved requests marked skipped have not been fabricated into completed history.
- Initial GitHub application and Docker workflows passed for commit `35da2b6`. The queue fix will be validated again before the requested `v1.0.1` GHCR publication.

## Automated validation

Run `npm run check`, then:

```powershell
docker compose build --pull --no-cache
node scripts/docker-smoke.js vibeq:local
```

The smoke test creates its own volume and credentials and removes only those disposable resources. Never reuse real room data for automated tests. The release workflow repeats application and container tests before publishing Linux amd64.

## Real account checklist

Use `.env.docker` with your own credentials, register the port 3001 callback, then run `docker compose up -d`.

- Open the homepage and player in a browser; unlock Host controls.
- Complete Spotify OAuth; confirm connection returns to this local app.
- Search, request songs from two guests, vote, and confirm FPQS ordering.
- Select a Spotify Connect device; test transfer, play, pause, skip and volume.
- Let the worker observe completed requested songs; save a named set.
- Run `docker compose down` followed by `docker compose up -d`; confirm saved set, queue, votes and played history survive.
- Confirm `docker compose ps` reports healthy and logs have no permission failures.
- Enable artwork alone with a configured image provider; confirm generated image retrieval and persistence after recreation.
- Enable trivia alone with a configured web-search Responses provider; confirm sourced trivia. Both tests can incur provider charges.
- Inspect image configuration/history and runtime contents for unexpected credentials or workstation files. Build context uses an allowlist; no `.env`, `.deploy`, Git history, database or generated artwork should be included.

Record actual results and release tag here. Do not describe mock-provider coverage as live Spotify/AI verification or claim an unpublished GHCR package exists.
