# Deploying QLook

**Live:** https://qlook.jawab.sa · **Admin:** https://qlook.jawab.sa/admin

## How a change goes live

1. Merge or push to `main`.
2. Within about a minute the server notices the new commit, builds the Docker image, and runs the test suite inside the build.
3. If the build and tests pass, the new container replaces the old one. If its health check fails, the server rolls back to the previous version on its own.

A commit that fails is skipped until the next push. Nobody needs server access for any of this.

- **Check what's live:** `https://qlook.jawab.sa/healthz` returns the deployed commit SHA. The admin page shows it too.
- **Catch failures before they reach the server:** the `CI` workflow runs the same Docker build (tests included) on every push and pull request. If it's red, the server will reject that commit as well.

## Gemini API key

The key is not stored in the repo or in environment variables. Sign in at `/admin` and paste it there. Google checks the key before it's saved, and it takes effect immediately, no redeploy needed. It's kept on the server's data volume and survives deploys.

## Running locally

```sh
ADMIN_PASSWORD=change-me-locally node server.js   # http://localhost:8080
npm test
```

Rate limiting needs an Upstash-compatible Redis REST endpoint (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`). Without one, `/api/generate` answers 503 `RATE_LIMIT_UNAVAILABLE`.

## Server layout (for admins only)

| Path | Purpose |
|---|---|
| `/opt/qlook/docker-compose.yml` | app + Redis + Upstash-compatible REST shim (copy of `deploy/docker-compose.yml`) |
| `/opt/qlook/app.env`, `redis.env` | server secrets: bootstrap admin password, session secret, Redis token |
| `/opt/qlook/deploy.sh` | the deployer (copy of `deploy/deploy.sh`) |
| `qlook-deploy.timer` | runs the deployer every minute as user `qlook-deploy` |
| `/opt/qlook/deploy.log`, `state/build-<sha>.log` | deploy history and build output |

The server runs its own installed copies of the compose file and deploy script, not the ones in this repo, so a push can't change how the host itself is configured. If you change them here, an admin has to copy them over.
