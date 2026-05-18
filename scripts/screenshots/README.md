# scripts/screenshots

Captures full-page PNGs of the Mergecrew web app for `docs/` and marketing
(README hero, LinkedIn posts, blog images). Output lives in
[`docs/assets/screenshots`](../../docs/assets/screenshots/).

Routes are defined in [`routes.ts`](./routes.ts); edit there to add or rename
captures.

## Prereqs

```bash
pnpm install
pnpm exec playwright install chromium    # one-time, ~150 MB
```

You'll also need the web app running. The script defaults to
`http://localhost:3000`:

```bash
pnpm compose:full        # easiest — boots api + orchestrator + runner + web + db
# or
pnpm dev                 # if you're hacking locally
```

The web app has `MERGECREW_DEV_AUTO_LOGIN=true` by default, so the script
walks straight into the app as `demo@mergecrew.local`. The public landing
page (`01-landing`) only renders if you flip auto-login off — see below.

## Usage

```bash
pnpm screenshots                                # all routes, desktop + mobile, light + dark
pnpm screenshots -- --routes 06-timeline        # just the hero
pnpm screenshots -- --routes 06-timeline,07-digest --viewport desktop --theme dark
pnpm screenshots -- --url https://staging.mergecrew.io
```

Output files are named `<name>.<theme>.<viewport>.png`, e.g.
`06-timeline.dark.desktop.png`. The README and LinkedIn copy can link to those
stable names.

## Flags

| Flag         | Default                              | Notes                                                |
| ------------ | ------------------------------------ | ---------------------------------------------------- |
| `--url`      | `http://localhost:3000`              | Or set `MERGECREW_SCREENSHOT_URL`                    |
| `--out`      | `docs/assets/screenshots`            | Output directory                                     |
| `--routes`   | _(all)_                              | Comma-separated route `name`s from `routes.ts`       |
| `--viewport` | `both`                               | `desktop` (1440×900 @2x), `mobile` (390×844 @3x)     |
| `--theme`    | `both`                               | `light`, `dark`                                      |
| `--headed`   | `false`                              | Open a visible browser (useful for debugging)        |
| `--timeout`  | `20000`                              | Per-navigation timeout in ms                         |

The seeded `demo` org and `acme` project work out of the box. To screenshot a
different tenant, set:

```bash
MERGECREW_SCREENSHOT_ORG=acmeco MERGECREW_SCREENSHOT_PROJECT=storefront pnpm screenshots
```

## Capturing the public landing page

The landing page (`01-landing`) lives at `/` but only renders when there's no
session. With auto-login on, the BFF redirects you straight into the app.
Run web with auto-login disabled for that one capture:

```bash
MERGECREW_DEV_AUTO_LOGIN=false pnpm --filter @mergecrew/web dev
# then in another shell:
pnpm screenshots -- --routes 01-landing
```

## CI

This isn't wired into CI on purpose — Playwright + headless chromium is heavy
and screenshot diffs are too noisy for assertion-style tests. Capture by hand
on a release branch when the UI changes.
