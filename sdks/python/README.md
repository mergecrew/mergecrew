# mergecrew

Official Python SDK for the [Mergecrew](https://github.com/mergecrew/mergecrew) API.

A thin httpx-based wrapper that mirrors the canonical surface of `@mergecrew/sdk` (TypeScript). Tracks the same `docs/openapi.json` snapshot the API publishes at every release.

## Install

```sh
pip install mergecrew
```

## Quick start

```python
import os
from mergecrew import Mergecrew

mc = Mergecrew(api_key=os.environ["MERGECREW_API_KEY"])  # mc_live_… from org settings

# List projects.
for project in mc.list_projects("demo"):
    print(project["slug"])

# Kick a manual run.
run = mc.create_run("demo", "acme")
print(run["id"])

# Walk the timeline.
for event in mc.get_timeline("demo", "acme", run["id"]):
    print(event["type"], event["occurredAt"])
```

For endpoints not yet covered by a convenience method, drop to the low-level request:

```python
data = mc.request(
    "POST",
    "/v1/orgs/{slug}/api-keys",
    path_params={"slug": "demo"},
    json={"name": "ci-bot", "role": "operator"},
)
print(data["token"])  # shown ONCE — store it
```

## Configuration

| Argument | Required | Default |
|---|---|---|
| `api_key` | yes | — |
| `base_url` | no | `https://api.mergecrew.dev` |
| `timeout` | no | `30.0` (seconds) |

For self-hosted Mergecrew deployments, set `base_url` to your install's API host.

## Async

`httpx.AsyncClient` support is on the roadmap. For now the client is sync-only; if you need async, wrap calls in `asyncio.to_thread`.

## Authentication

Issue an API key from your org settings page (admin-only). Tokens look like `mc_live_<random>` and are shown exactly once at creation. Lost tokens cannot be recovered — revoke and reissue.
