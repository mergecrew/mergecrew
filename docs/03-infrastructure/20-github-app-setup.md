# GitHub App setup

mergecrew opens PRs, dispatches deploys, and reads repo state through a
**GitHub App** you own and install on each tenant's org. This page walks
through registering the App on GitHub and wiring its callback URLs so
the wizard can complete the install round-trip.

If you skip the **Setup URL**, the install will appear to succeed —
GitHub creates the installation row — but the user gets stranded on
GitHub's installation settings page (`https://github.com/organizations/<org>/settings/installations/<id>`)
instead of bouncing back to mergecrew. That's the #1 cause of "I
installed it but nothing happened".

## What you need

- A GitHub account with permission to register Apps under the user or
  organization that owns mergecrew.
- The public hostnames for your web and API tiers
  (`mergecrew.dev` / `api.mergecrew.dev` in our example; substitute
  your own).
- Generated private key (PEM) — stored as `GITHUB_APP_PRIVATE_KEY`.

## 1. Register the App

Go to [github.com/settings/apps/new](https://github.com/settings/apps/new)
(or `/organizations/<org>/settings/apps/new` to own it from an org).

**Identifying fields**

| Field | Value |
|---|---|
| App name | `mergecrew` (whatever you set as `GITHUB_APP_SLUG`) |
| Homepage URL | `https://mergecrew.dev` |
| Description | *Optional — appears on the install consent screen.* |

**URLs — required for the install round-trip**

| Field | Value | Notes |
|---|---|---|
| **Setup URL (post-install)** | `https://api.mergecrew.dev/v1/integrations/github/install/callback` | Where GitHub sends the user after a successful install. Without this, GitHub strands them on its own settings page. |
| **Redirect on update** | ✅ checked | So existing-installation reconfigures also land back on the callback. |
| **Callback URL** (Identifying and authorizing users) | `https://api.mergecrew.dev/v1/integrations/github/install/callback` | **Required.** mergecrew verifies every installation with GitHub before connecting it to an org (see [Installation ownership](#installation-ownership)). Keep the NextAuth sign-in callback (`https://mergecrew.dev/api/auth/callback/github`) in the list too if you use GitHub sign-in — GitHub Apps accept several callback URLs. |
| Request user authorization (OAuth) during installation | *Optional.* | When checked, GitHub sends the user to the Callback URL (not the Setup URL) right after install, already carrying the authorization `code` — one fewer redirect. When unchecked, mergecrew sends the user through the authorization step itself after the Setup URL. Both work. |
| Expire user authorization tokens | ✅ (default) | mergecrew only uses the user token once, during the callback, and never stores it. |

**Webhook**

| Field | Value |
|---|---|
| Webhook URL | `https://api.mergecrew.dev/v1/webhooks/github` |
| Webhook secret | A long random string. Store as `GITHUB_APP_WEBHOOK_SECRET`. **Required** — the API rejects every webhook (403) while it is empty. |
| SSL verification | Enable (✅). |

## 2. Permissions

Set under **Permissions → Repository permissions**.

| Permission | Access |
|---|---|
| Actions | Read & write — needed by the GitHub Actions deploy adapter |
| Administration | Read-only — branch-protection introspection |
| Checks | Read & write |
| Contents | Read & write |
| Issues | Read & write |
| Metadata | Read-only (auto-set) |
| Pull requests | Read & write |
| Workflows | Read & write — so the agents can author `.github/workflows/*.yml` |

**Organization permissions** — none required for basic install.

**Subscribe to events**: at minimum `pull_request`, `push`,
`workflow_run`. (`installation` events are always delivered to GitHub
Apps; mergecrew uses them to drop the org binding when the App is
uninstalled and to pause it while the installation is suspended.) Add `check_run`, `check_suite`, `issues` if you want
mergecrew to react to CI failures and external issue activity.

## 3. Generate the private key

On the App's settings page, scroll to **Private keys → Generate a
private key**. GitHub downloads a PEM file. Store the contents as the
`GITHUB_APP_PRIVATE_KEY` env var (literal PEM body, including the
`-----BEGIN…-----` / `-----END…-----` lines).

The App ID is at the top of the same page; store as `GITHUB_APP_ID`.

## 4. Wire the env

In your web + api environment:

```sh
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=mergecrew              # the URL-safe slug, e.g. github.com/apps/<slug>
GITHUB_APP_PRIVATE_KEY="$(cat key.pem)"
GITHUB_APP_CLIENT_ID=Iv1.xxxxxxxx         # App settings → "Client ID"
GITHUB_APP_CLIENT_SECRET=<generated>      # App settings → "Generate a new client secret"
GITHUB_APP_WEBHOOK_SECRET=<random>
# Optional: redirect_uri used for the authorization step. Defaults to
# $MERGECREW_PUBLIC_API_BASE_URL/v1/integrations/github/install/callback
# when MERGECREW_PUBLIC_API_BASE_URL is set; otherwise GitHub uses the
# App's *first* Callback URL, so either set this or list the API
# callback first.
GITHUB_APP_INSTALL_REDIRECT_URI=https://api.mergecrew.dev/v1/integrations/github/install/callback
WEB_BASE_URL=https://mergecrew.dev      # used to build the redirect Location
API_BASE_URL=http://api:4000            # internal address the web BFF talks to
```

`GITHUB_APP_SLUG` must match the slug GitHub assigned to your App
(visible as `https://github.com/apps/<slug>`). It drives the install
URL the **Install GitHub App** button links to.

`GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` must be set on the
**API** container: without them the callback can't verify the
installation and lands on `?github_install_error=oauth_not_configured`.

## Installation ownership

Every installation of the App shares one App private key, so mergecrew
binds each installation id to exactly one org (`org_github_installations`)
and refuses to use installations that aren't bound to the caller's org:

- `GET /v1/orgs/:slug/projects/:p/installation-repos/:id`,
  `POST /v1/orgs/:slug/projects/:p/connect-repo` and GitHub Actions deploy
  targets return **403** for an installation not bound to the org.
- The runner refuses to mint installation tokens for a connected repo
  (or GitHub Actions deploy target) whose installation isn't bound to the
  repo's org.
- The `manual` placeholder installation is accepted only in dev mode
  (`MERGECREW_DEV_AUTO_LOGIN=true`, which defaults to true when
  `NODE_ENV` isn't `production`).

A binding is written only after the install round-trip proves the
installation belongs to the person who started it:

1. `GET /v1/integrations/github/install` (operator+ member of the org)
   signs a short-lived `state` carrying the user and org.
2. GitHub redirects to the callback with `installation_id`. That
   parameter can be spoofed, so the callback pins it into a fresh signed
   state and sends the user through the App's user authorization step.
3. With the returned `code`, the API obtains a user access token and
   requires the installation to appear in `GET /user/installations`
   for that GitHub user. The token is used once and discarded.
4. The API issues a 10-minute signed grant and redirects to the web tier
   (`/orgs/<slug>/github-install/complete`), which redeems it via
   `POST /v1/orgs/:slug/github/installations/confirm` with the signed-in
   user's session. The binding is saved only if the grant was issued to
   that same user and org.

An installation can belong to one org only; installing it for a second
org returns `?github_install_error=installation_bound_to_other_org`.
Reinstalling / reconfiguring from the owning org refreshes the binding.

**Upgrading an existing deployment.** The migration
`20261126100000_org_github_installations` backfills a binding for every
installation id already used by `connected_repos` rows of exactly one
org. Installation ids used by several orgs are left unbound (the
migration prints a `NOTICE` for each); repos on them stop working until
the legitimate owner re-runs **Install GitHub App** from their org.

## 5. Verify

1. Sign in to mergecrew, open the wizard, advance to **Step 3: Connect
   a repo**, click **Install GitHub App**.
2. Browser should hit `https://mergecrew.dev/orgs/<slug>/projects/<ps>/install-github?from=wizard`
   (the BFF) which 302s to `https://github.com/apps/<your-app>/installations/new?state=…`.
3. Pick the repos to grant access to and click **Install**.
4. GitHub redirects you to your **Setup URL**; the API sends you
   through GitHub's "Authorize mergecrew" step (skipped if you already
   authorized it, or if "Request user authorization during installation"
   is enabled), verifies the installation, and forwards you via
   `https://mergecrew.dev/orgs/<slug>/github-install/complete` to
   `https://mergecrew.dev/orgs/<slug>/onboarding?installation_id=…&from=github_install`.
5. The wizard's repo step is now expanded with a dropdown of the repos
   the App was granted access to. Pick one, click **Connect**.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| After install, browser stays on `github.com/.../settings/installations/<id>` | Setup URL not configured on the App | Set it under App settings → "Setup URL (post-install)" and re-install (or paste `https://mergecrew.dev/orgs/<slug>/onboarding?installation_id=<id>&from=github_install` into the address bar to resume manually). |
| Click Install → 401 from `api.mergecrew.dev/v1/integrations/github/install` | Pre-#457 deploy; install link wasn't BFF'd through the web tier | Update to a build that includes #457 + #459. |
| Callback lands on `mergecrew.dev/?github_install_error=bad_state` | State HMAC expired (15 min TTL) or signing secret rotated between sign and verify | Re-click Install. If `JWT_SECRET` changed, all in-flight states are dead — expected. |
| Callback lands on `mergecrew.dev/?github_install_error=bad_callback` | Setup URL is hitting the API but `installation_id` is missing from the query | GitHub didn't include it — usually means the App's Setup URL is set to the *web* host instead of the *API* host. Setup URL must point at the API callback. |
| Browser lands on `https://<internal-container-host>:3000/...` | Reverse proxy not forwarding `X-Forwarded-Host` (or `WEB_BASE_URL` unset) | Set `WEB_BASE_URL` in the web container's env. |
| Callback lands on `…?github_install_error=oauth_not_configured` | `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` missing on the API container | Set both (App settings → Client ID / Generate a new client secret) and restart the API. |
| GitHub shows "The redirect_uri is not associated with this application" | The API callback isn't registered as a Callback URL, or `GITHUB_APP_INSTALL_REDIRECT_URI` doesn't match one | Add `https://<api-host>/v1/integrations/github/install/callback` under App settings → Callback URL. |
| Callback lands on `…?github_install_error=installation_not_accessible` | The GitHub account that authorized can't access that installation (or the `installation_id` was tampered with) | Install / authorize with a GitHub account that has access to the org where the App is installed. |
| Lands on `…?github_install_error=installation_bound_to_other_org` | The installation is already connected to a different mergecrew org | Connect it from the owning org, or uninstall it there first. |
| `connect-repo` / repo dropdown returns 403 "installation is not connected to this organization" | Installation not bound to this org (e.g. pre-upgrade row left unbound by the migration) | Re-run **Install GitHub App** from this org. |
| Wizard repo dropdown is empty after install | API can't list installation repos — likely `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` missing on the **API** container | Restart api after setting them. |

## Reference

- **API endpoints**:
  - `GET /v1/integrations/github/install?org=<slug>&project=<slug>&from=wizard|settings` — mints signed state, redirects to GitHub.
  - `GET /v1/integrations/github/install/callback?installation_id=…&state=…[&code=…]` — verifies state, verifies the installation with GitHub, issues a grant.
  - `POST /v1/orgs/:slug/github/installations/confirm` — redeems the grant with the user's session and writes the org binding.
  - Source: `apps/api/src/modules/integration/github-app.controller.ts`.
- **Web BFF**: `apps/web/src/app/orgs/[slug]/projects/[projectSlug]/install-github/route.ts` — forwards the install request with the user's Bearer JWT so the API auth middleware sees a real session; `apps/web/src/app/orgs/[slug]/github-install/complete/route.ts` — redeems the install grant.
- **Required repo permissions** are also enumerated in
  [`16-self-host-runbook.md` → "GitHub App scopes too narrow"](16-self-host-runbook.md#github-scopes).
