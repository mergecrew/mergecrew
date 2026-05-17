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
| Callback URL (user authorization) | *Leave blank unless you need GitHub OAuth for end users.* | We don't use the OAuth flow today; the install flow alone is enough. |

**Webhook**

| Field | Value |
|---|---|
| Webhook URL | `https://api.mergecrew.dev/v1/webhooks/github` |
| Webhook secret | A long random string. Store as `GITHUB_WEBHOOK_SECRET`. |
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
`workflow_run`. Add `check_run`, `check_suite`, `issues` if you want
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
GITHUB_WEBHOOK_SECRET=<random>
WEB_BASE_URL=https://mergecrew.dev      # used to build the redirect Location
API_BASE_URL=http://api:4000            # internal address the web BFF talks to
```

`GITHUB_APP_SLUG` must match the slug GitHub assigned to your App
(visible as `https://github.com/apps/<slug>`). It drives the install
URL the **Install GitHub App** button links to.

## 5. Verify

1. Sign in to mergecrew, open the wizard, advance to **Step 3: Connect
   a repo**, click **Install GitHub App**.
2. Browser should hit `https://mergecrew.dev/orgs/<slug>/projects/<ps>/install-github?from=wizard`
   (the BFF) which 302s to `https://github.com/apps/<your-app>/installations/new?state=…`.
3. Pick the repos to grant access to and click **Install**.
4. GitHub redirects you to your **Setup URL** which the API processes
   and forwards to `https://mergecrew.dev/orgs/<slug>/onboarding?installation_id=…&from=github_install`.
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
| Wizard repo dropdown is empty after install | API can't list installation repos — likely `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` missing on the **API** container | Restart api after setting them. |

## Reference

- **API endpoints**:
  - `GET /v1/integrations/github/install?org=<slug>&project=<slug>&from=wizard|settings` — mints signed state, redirects to GitHub.
  - `GET /v1/integrations/github/install/callback?installation_id=…&state=…` — verifies state, redirects to wizard or settings.
  - Source: `apps/api/src/modules/integration/github-app.controller.ts`.
- **Web BFF**: `apps/web/src/app/orgs/[slug]/projects/[projectSlug]/install-github/route.ts` — forwards the install request with the user's Bearer JWT so the API auth middleware sees a real session.
- **Required repo permissions** are also enumerated in
  [`16-self-host-runbook.md` → "GitHub App scopes too narrow"](16-self-host-runbook.md#github-scopes).
