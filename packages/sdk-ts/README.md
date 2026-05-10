# @mergecrew/sdk

Official TypeScript SDK for the [Mergecrew](https://github.com/mergecrew/mergecrew) API.

End-to-end-typed wrapper around the OpenAPI snapshot the API publishes at every release. Every path and method from `docs/openapi.json` is reachable; types are regenerated whenever the spec changes.

## Install

```sh
npm i @mergecrew/sdk
# or
pnpm add @mergecrew/sdk
```

## Quick start

```ts
import { createMergecrew } from '@mergecrew/sdk';

const mc = createMergecrew({
  apiKey: process.env.MERGECREW_API_KEY!, // mc_live_… from the org settings
});

// List projects in an org.
const { data, error } = await mc.GET('/v1/orgs/{slug}/projects', {
  params: { path: { slug: 'demo' } },
});

if (error) throw new Error(`API error: ${error}`);
console.log(data?.items);

// Kick a manual run.
await mc.POST('/v1/orgs/{slug}/projects/{projectSlug}/runs', {
  params: { path: { slug: 'demo', projectSlug: 'acme' } },
});
```

## Configuration

| Option | Required | Default |
|---|---|---|
| `apiKey` | yes | — |
| `baseUrl` | no | `https://api.mergecrew.dev` |
| `clientOptions` | no | forwarded to `openapi-fetch` (custom `fetch`, etc.) |

For self-hosted Mergecrew deployments, set `baseUrl` to the API host of your install.

## Authentication

Issue an API key from your org settings page (admin-only). Tokens look like `mc_live_<random>` and are shown exactly once at creation. Lost tokens cannot be recovered — revoke and reissue.

The SDK accepts either an API key or a user JWT in the `apiKey` field; it always sends `Authorization: Bearer <value>`.

## Versioning

The SDK is regenerated against the `docs/openapi.json` snapshot in this repo. CI fails if the controllers drift from the committed spec without a matching regeneration.
