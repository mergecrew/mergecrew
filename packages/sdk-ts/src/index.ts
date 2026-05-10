import createClient, { type Client, type ClientOptions } from 'openapi-fetch';
import type { paths } from './generated.js';

export type { paths } from './generated.js';
export type MergecrewClient = Client<paths>;

export interface MergecrewOptions {
  /** Bearer token. Either a `mc_live_…` API key (#138) or a user JWT. */
  apiKey: string;
  /** Default `https://api.mergecrew.dev`. Override for self-hosted or local dev (e.g. `http://localhost:4000`). */
  baseUrl?: string;
  /** Optional overrides forwarded to openapi-fetch (custom fetch, headers, etc). */
  clientOptions?: Omit<ClientOptions, 'baseUrl' | 'headers'>;
}

const DEFAULT_BASE_URL = 'https://api.mergecrew.dev';

/**
 * Construct a typed Mergecrew API client. Every path/method from the
 * committed OpenAPI snapshot (`docs/openapi.json`) is reachable via
 * `client.GET('/v1/orgs/{slug}/runs', { params: { path: { slug } } })`
 * with end-to-end types.
 *
 * @example
 *   const mc = createMergecrew({ apiKey: process.env.MERGECREW_KEY! });
 *   const { data, error } = await mc.GET('/v1/orgs/{slug}/projects', {
 *     params: { path: { slug: 'demo' } },
 *   });
 */
export function createMergecrew(options: MergecrewOptions): MergecrewClient {
  return createClient<paths>({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    headers: {
      authorization: `Bearer ${options.apiKey}`,
    },
    ...(options.clientOptions ?? {}),
  });
}
