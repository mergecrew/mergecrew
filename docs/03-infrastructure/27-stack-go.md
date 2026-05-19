# Stack cookbook: Go

Default workspace image: [`ghcr.io/mergecrew/runner-go:1.22`](22-runner-images.md). Carries Go 1.22 + golangci-lint.

## Detection signals

`go.mod` in the workspace root.

## Default build commands

| Skill | Command |
| --- | --- |
| install | `go mod download` |
| typecheck | `go build ./...` (catches type errors during compile) |
| lint | `golangci-lint run` |
| test | `go test ./...` |
| integration | (null — no convention; override when needed) |

`go build ./...` doubles as a typecheck — Go's compiler fails on type errors, so a successful build means types check. No separate `go vet` step in the defaults (operators add it via `lint` override when they want).

## Common overrides

```yaml
runner:
  image: ghcr.io/mergecrew/runner-go:1.22
  resources: { cpu: 4, memory: 4Gi }
build:
  commands:
    # Add `go vet` alongside golangci-lint
    lint: { cmd: "sh", args: ["-c", "go vet ./... && golangci-lint run"] }
    # Race detector on
    test: { cmd: "go", args: ["test", "-race", "./..."] }
    # Project has a tagged integration suite
    integration: { cmd: "go", args: ["test", "-tags=integration", "./..."] }
```

Pin a specific Go version via `.tool-versions`:

```
# .tool-versions
go 1.22.1
```

## Common gotchas

- **Module cache.** `go mod download` populates `$GOPATH/pkg/mod` (the image presets `GOPATH=/go`). The per-run tmpfs is wiped between runs — cold-pull every time. Operators with frequent runs can mount a per-project volume at `/go/pkg/mod` (Phase 3 cache.paths, #572).
- **GOFLAGS / GOPRIVATE.** Inject project secrets via `ProjectSecret` rows; the supervisor passes them as `opts.env` (which the env scrub at execa allows through explicitly). Don't bake into the image.
- **CGO.** `runner-go:1.22` ships `golang:1.22-bookworm`, which has the C toolchain. Pure-Go projects can switch to the `slim` variant — set `runner.image` accordingly.

## Worked example

[**grafana/grafana**](https://github.com/grafana/grafana) — Go backend, large module tree.

```yaml
version: 1
runner:
  image: ghcr.io/mergecrew/runner-go:1.22
  resources: { cpu: 8, memory: 16Gi, timeout: 60m }
build:
  commands:
    test: { cmd: "make", args: ["test-go"] }
    lint: { cmd: "make", args: ["lint-go"] }
```

Grafana's Makefile orchestrates a subset of `go test` with project-specific flags — call the `make` target directly rather than reinventing it.

## Refs

- Image: `infra/images/runner-go/Dockerfile` (#567)
- Detection matrix: `packages/skills/src/stock/detect-stack.ts` (#566)
