# Docker implementation plan

Status: local Linux amd64 build, container/storage checks, live Spotify queue/history checks and live AI provider tests passed; GHCR publication pending. Live testing identified and fixed Spotify command acknowledgement parsing and playback reconciliation. See [validation results and checklist](docker-validation.md). Docker support is targeted for v1.0.1. The v1.0.0 release supports the documented Node.js setup; it does not include a Docker image.

Docker will provide a repeatable way to run the standalone player locally, with SQLite and optional artwork and trivia. Azure remains an optional deployment choice.

## 1. Prepare the local runtime

- Add a configurable `HOST`, preserving `127.0.0.1` as the normal local default and using `0.0.0.0` inside the container.
- Keep port 3001 and serve the built website, player and `/api` from the same Node.js process.
- Use relative API URLs in the frontend build. Do not bake the live demo's Azure Function URL into the image.
- Check graceful shutdown so stopping the container closes the server and database cleanly.

## 2. Write the image recipe

Create a multi-stage `Dockerfile`: a build stage runs `npm ci` and builds the Vite frontend; a runtime stage contains production dependencies, `dist`, the server and its artwork seed asset. Use an official Node.js 24 Debian slim image and run as a non-root user.

A Dockerfile is the recipe. Building it produces an image; starting that image produces a container.

Add `.dockerignore` to exclude credentials, `.env` files, `.deploy`, local databases and artwork, Git history, dependency folders and existing build output. Pass credentials only when starting the container.

## 3. Define how users run it

Create `compose.yaml` with a named volume mounted at `/app/data`. This preserves queued requests, played songs, saved sets and generated artwork when the container is replaced. Compose describes the port, environment and storage settings needed to run the image.

For local use, publish port 3001 on the host's loopback address only. Set `APP_ORIGIN=http://127.0.0.1:3001`, `SPOTIFY_REDIRECT_URI=http://127.0.0.1:3001/api/spotify/callback`, `DATA_DIR=/app/data` and `STORAGE_DRIVER=sqlite`. Register that callback in the user's Spotify developer app before connecting.

Require the user's own Spotify credentials, host password and session secret through a runtime environment file. Leave artwork and trivia disabled by default; document how to enable them with the same provider settings used by the existing local runtime. Public hosting requires HTTPS and matching Spotify callback settings.

## 4. Verify the complete experience

Install Docker Desktop with Linux containers for the implementation and validation work. The Docker CLI was not available on the current workstation when this plan was prepared.

Validate a clean build, homepage and player loading, API health, Spotify login and playback controls, search, voting and FPQS. Save a set, stop and recreate the container, then confirm the set and queue data survive. Check volume permissions, restart behavior and that the image contains no credentials or workstation data. Test artwork and trivia separately with configured providers.

## 5. Document and distribute

Update the README with a beginner-friendly build/run walkthrough, Spotify callback instructions, optional add-ons, updating the image and backing up the data volume. Clearly distinguish stopping a container from explicitly deleting its persistent volume.

After local verification, add a GitHub Actions image build and publish tagged images to GitHub Container Registry (GHCR). This is where GitHub Packages becomes useful: it hosts the built image, while GitHub Releases explains each version. Start with a tested Linux architecture and add other architectures after verification.

Use an image tag matching the release that actually introduces Docker support. Do not label an untested future image as an existing v1.0.0 deliverable.

## Repository naming

The repository is now [vibeQ-player/vibeq](https://github.com/vibeQ-player/vibeq). Version numbers belong in release tags, starting with `v1.0.0`. The Git remote, README, website links and release notes have been updated following the rename from `v1`; the website domain and Azure resource names are unchanged.

## Reference documentation

- [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/)
- [Docker build best practices](https://docs.docker.com/build/building/best-practices/)
- [GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [Renaming a GitHub repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
