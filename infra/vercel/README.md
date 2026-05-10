# Vercel deployment for `apps/web`

The Next.js BFF (`apps/web`) ships to Vercel via the
`.github/workflows/deploy-web.yml` workflow. CI builds the prebuilt
artifact (pinned Node + pnpm) and uploads it with `vercel deploy
--prebuilt`, so the deployed binary matches the lockfile this repo
committed.

## One-time setup

1. **Create a Vercel project.**
   - https://vercel.com/new → Import Git Repository → pick this repo.
   - During setup, set **Root Directory** to `apps/web`. Build/install
     commands and output dir are read from `apps/web/vercel.json` —
     leave those at "Override → Auto" in the Vercel UI.
   - Disable "Automatically deploy on every push" — the GitHub Actions
     workflow owns that.

2. **Mint an API token.**
   - https://vercel.com/account/tokens → "Create" → save somewhere safe
     (one-time display).

3. **Look up the IDs.**
   - Project Settings → General: `Project ID`
   - Account/Team Settings → General: `Team ID` (this is the
     `VERCEL_ORG_ID` for personal + team accounts alike).

4. **Wire GitHub secrets** (Settings → Secrets and variables → Actions):
   - `VERCEL_TOKEN` — the token from step 2
   - `VERCEL_ORG_ID` — the team / account ID from step 3
   - `VERCEL_PROJECT_ID` — from step 3

5. **Enable the workflow** (Settings → Secrets and variables → Actions
   → Variables): add a repository variable
   `VERCEL_DEPLOY_ENABLED=true`. Until this is set, the workflow runs
   on push but skips the deploy job — keeps the file shape reviewable
   without forcing every contributor to set up Vercel locally.

6. **Set runtime env vars in Vercel** (Project Settings →
   Environment Variables → Production):
   - `API_BASE_URL` — public URL of the API service (e.g.
     `https://api.mergecrew.example.com`)
   - `WEB_BASE_URL` — same as the Vercel deploy URL or your custom
     domain (used for magic-link callback URLs in #1)
   - `BFF_TRUST_TOKEN` — shared secret with the API for `/v1/auth/
     exchange` (must match the api's env)
   - `MERGECREW_DEV_AUTO_LOGIN=false`
   - OAuth secrets if used (`GITHUB_OAUTH_CLIENT_ID`, etc.)
   - `NEXTAUTH_SECRET`, `NEXTAUTH_URL` (production URL)

## Smoke test

Trigger the workflow manually:

```sh
gh workflow run deploy-web.yml
```

Watch the run; on success the summary block has the deploy URL.
Hit it; you should land on the login page. The first sign-in via the
email magic-link flow exercises the `/v1/auth/magic-link/*` round-trip
end-to-end against your real API host.

## Local mirror of the build

To reproduce the Vercel build locally without deploying:

```sh
cd apps/web
vercel pull --environment=production --token=$VERCEL_TOKEN
vercel build --prod --token=$VERCEL_TOKEN
# .vercel/output/ now contains exactly what `vercel deploy --prebuilt`
# would ship.
```
