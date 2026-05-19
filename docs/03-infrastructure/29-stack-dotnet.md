# Stack cookbook: .NET

No `runner-dotnet` stock image in V1. Use BYO image (#571) with a Microsoft `mcr.microsoft.com/dotnet/sdk:8.0` base, layered onto the contract:

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:8.0-jammy
RUN groupadd --system --gid 1001 mergecrew \
    && useradd --system --uid 1001 --gid 1001 \
        --no-create-home --shell /bin/bash mergecrew \
    && mkdir -p /workspace \
    && chown 1001:1001 /workspace \
    && chmod 0775 /workspace
# tini + git + curl + mise — same contract every workspace image satisfies.
RUN apt-get update && apt-get install -y bash ca-certificates curl git tini \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://mise.run | sh \
    && mv /root/.local/bin/mise /usr/local/bin/mise
USER mergecrew
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]
```

Build, push to your registry, point `runner.image` at it.

## Detection signals

Any `*.csproj` / `*.fsproj` / `*.vbproj` in the workspace root (today the auto-detection in `detectStack` doesn't look at glob patterns — it expects a manifest at the workspace root. For .NET, set `runner.image` and override the commands explicitly).

The matrix will gain `*.csproj` detection in a future iteration; until then the project explicitly opts in via `mergecrew.yaml`.

## Default build commands

When detection lands, the defaults will be:

| Skill | Command |
| --- | --- |
| install | `dotnet restore` |
| typecheck | `dotnet build --no-restore` |
| lint | `dotnet format --verify-no-changes` |
| test | `dotnet test` |
| integration | (null) |

Today, set these via `mergecrew.yaml`:

## Common overrides

```yaml
# mergecrew.yaml
runner:
  image: ghcr.io/acme/runner-dotnet:8.0   # your BYO image
  resources: { cpu: 4, memory: 4Gi }
build:
  commands:
    install:   { cmd: "dotnet", args: ["restore"] }
    typecheck: { cmd: "dotnet", args: ["build", "--no-restore"] }
    lint:      { cmd: "dotnet", args: ["format", "--verify-no-changes"] }
    test:      { cmd: "dotnet", args: ["test", "--no-build"] }
```

## Common gotchas

- **NuGet config.** Per-project `NuGet.Config` works; `~/.nuget` is on the per-run tmpfs so private-feed credentials must come from a `ProjectSecret` row injected via `opts.env`.
- **MSBuild + parallelism.** `dotnet build` parallelizes per cpu count. Setting `runner.resources.cpu: 4` is usually enough; higher counts hit diminishing returns on small projects.
- **Linux-only.** .NET on Linux (i.e. all `dotnet` CLI on Mergecrew). Windows-specific MSBuild targets won't run. Tracked under V3+ (`docs/02-architecture/13-runner-isolation.md` § 10 / Windows note).

## Worked example

[**dotnet/aspnetcore**](https://github.com/dotnet/aspnetcore) — large multi-project solution.

```yaml
version: 1
runner:
  image: ghcr.io/acme/runner-dotnet:8.0
  resources: { cpu: 8, memory: 16Gi, timeout: 60m }
build:
  commands:
    install: { cmd: "./restore.sh", args: [] }
    test:    { cmd: "./eng/common/build.sh", args: ["--test"] }
```

ASP.NET Core ships shell wrappers around the SDK; calling them directly avoids re-implementing their orchestration.

## Refs

- BYO image contract: [Workspace images](22-runner-images.md)
- Detection matrix: `packages/skills/src/stock/detect-stack.ts` (#566) — `.csproj` detection TBD.
