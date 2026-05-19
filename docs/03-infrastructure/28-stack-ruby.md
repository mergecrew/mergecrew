# Stack cookbook: Ruby

There's no `runner-ruby` stock image in V1 (#567 ships Node / Python / Go / Java + polyglot). Two routes work today:

1. **Polyglot image + mise.** Use `ghcr.io/mergecrew/runner-polyglot:lts` and pin Ruby via `.tool-versions` — `mise install` will install Ruby on the first run (~30s cold).
2. **BYO image (#571).** Set `runner.image` to a Ruby base image (e.g. `ruby:3.3-bookworm`) plus the contract (uid 1001, `/workspace`, `bash`, `git`, `tini`).

## Detection signals

`Gemfile` in the workspace root.

## Default build commands

| Skill | Command |
| --- | --- |
| install | `bundle install` |
| typecheck | (null) |
| lint | `bundle exec rubocop` |
| test | `bundle exec rspec` |
| integration | (null) |

Ruby has no community-standard typecheck command — Sorbet / RBS adoption is uneven. Override when your project uses one:

## Common overrides

```yaml
# mergecrew.yaml
runner:
  image: ghcr.io/mergecrew/runner-polyglot:lts
  resources: { cpu: 4, memory: 4Gi }
build:
  commands:
    # Sorbet typecheck
    typecheck: { cmd: "bundle", args: ["exec", "srb", "tc"] }
    # Project uses minitest instead of rspec
    test: { cmd: "bundle", args: ["exec", "rake", "test"] }
```

Pin a Ruby version via `.tool-versions`:

```
# .tool-versions
ruby 3.3.5
```

## Common gotchas

- **Native extensions.** Gems with C extensions (nokogiri, pg, sqlite3) need a compiler in the image. The polyglot image carries `build-essential`; pure Ruby gems install instantly, but the first run with native gems takes a minute or two.
- **Bundler config.** `.bundle/config` in the workspace root applies — use it to point at a private gem source via env-injected `BUNDLE_HTTPS://___RUBYGEMS__.example.com/`.
- **Rails secret keys.** Inject via `ProjectSecret` rows. Never bake into a custom image.

## Worked example

[**rails/rails**](https://github.com/rails/rails) — `Gemfile`, Bundler.

```yaml
version: 1
runner:
  image: ghcr.io/mergecrew/runner-polyglot:lts
  resources: { cpu: 8, memory: 8Gi, timeout: 60m }
build:
  commands:
    test: { cmd: "bin/test", args: [] }
```

Rails ships a `bin/test` wrapper that orchestrates the multi-app monorepo's test layout — call it directly.

## Refs

- Polyglot image: `infra/images/runner-polyglot/Dockerfile` (#567)
- Detection matrix: `packages/skills/src/stock/detect-stack.ts` (#566)
- A dedicated `runner-ruby` is tracked but not yet scheduled — see [stack catalog](22-runner-images.md).
