# Stack cookbook: Node

Default workspace image: [`ghcr.io/mergecrew/runner-node:20`](22-runner-images.md).

## Detection signals

The runner picks the Node stack when `package.json` is present in the workspace root. Package manager is inferred from the lockfile:

| File | Package manager |
| --- | --- |
| `pnpm-lock.yaml` | `pnpm` |
| `yarn.lock` | `yarn` |
| anything else | `npm` |

See `packages/skills/src/stock/detect-stack.ts` for the matrix and `packages/skills/test/detect-stack.test.ts` for the conformance tests.

## Default build commands

| Skill | Command |
| --- | --- |
| `build.run_install` | `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile` / `npm ci` |
| `build.run_typecheck` | `<pm> run typecheck` |
| `build.run_lint` | `<pm> run lint` |
| `build.run_unit_tests` | `<pm> run test` |
| `build.run_integration_tests` | `<pm> run test:integration` |

When the project hasn't defined the script under `package.json`'s `scripts`, the skill exits non-zero. Add the corresponding script — or override the command via `mergecrew.yaml`:

## Common overrides

```yaml
# mergecrew.yaml
build:
  commands:
    # Use tsc directly instead of a script that wraps it
    typecheck: { cmd: "pnpm", args: ["exec", "tsc", "--noEmit"] }
    # The project's tests are in `tests/` rather than wired to `npm test`
    test: { cmd: "pnpm", args: ["exec", "vitest", "run"] }
```

Pin a specific Node version via `.tool-versions` — the supervisor runs `mise install` before the first agent step (#568):

```
# .tool-versions
nodejs 20.10.0
```

## Worked example

[**vercel/next.js**](https://github.com/vercel/next.js) — pnpm workspaces.

```yaml
# mergecrew.yaml
version: 1
runner:
  image: ghcr.io/mergecrew/runner-node:20
  resources: { cpu: 4, memory: 8Gi }
build:
  commands:
    test: { cmd: "pnpm", args: ["test"] }
    typecheck: { cmd: "pnpm", args: ["run", "types"] }
```

`pnpm-lock.yaml` triggers pnpm detection. The default `pnpm install --frozen-lockfile` works. The Next.js repo uses `pnpm run types` rather than the standard `typecheck`, hence the override.

## Refs

- Image: `infra/images/runner-node/Dockerfile` (#558)
- Detection matrix: `packages/skills/src/stock/detect-stack.ts` (#566)
- RFC: `docs/02-architecture/13-runner-isolation.md` § 5.2
