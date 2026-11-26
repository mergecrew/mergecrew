import {
  discardBody,
  safeFetch,
  SafeFetchError,
  UnsafeEgressError,
  type EgressOptions,
} from '@mergecrew/net';

/**
 * Ollama capability probe. Queries the Ollama-compatible HTTP endpoint
 * for installed models and (optionally) per-model details. Used to
 * populate `capabilityOverrides.models` automatically when an Ollama
 * provider is registered, instead of relying on hand-edited lists.
 */

interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model?: string;
    modified_at?: string;
    size?: number;
    digest?: string;
    details?: {
      format?: string;
      family?: string;
      parameter_size?: string;
    };
  }>;
}

export interface OllamaProbeResult {
  ok: true;
  endpoint: string;
  models: string[];
  rawCount: number;
}

export interface OllamaProbeError {
  ok: false;
  error: string;
}

/**
 * Probe an Ollama endpoint's `/api/tags` to enumerate installed models.
 * Caller-supplied AbortSignal recommended; defaults to a 5s internal
 * timeout. Returns a flat list of model ids; the caller decides what
 * to persist.
 *
 * The endpoint is tenant-supplied, so the request goes through
 * `@mergecrew/net` `safeFetch` (private/metadata destinations refused
 * unless the operator opted in, socket pinned to the vetted address,
 * redirects not followed, 1 MiB response cap). Errors are deliberately
 * generic — they never echo the URL, upstream status or body, so the
 * probe can't be used to map what is listening where.
 */
export const OLLAMA_PROBE_FAILED = 'Could not reach an Ollama server at this endpoint.';

export async function probeOllama(
  endpoint: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; egress?: EgressOptions } = {},
): Promise<OllamaProbeResult | OllamaProbeError> {
  let url: string;
  try {
    const u = new URL(endpoint);
    u.pathname = u.pathname.replace(/\/+$/, '') + '/api/tags';
    u.search = '';
    u.hash = '';
    url = u.href;
  } catch {
    return { ok: false, error: OLLAMA_PROBE_FAILED };
  }

  try {
    const r = await safeFetch(
      url,
      { signal: opts.signal, redirect: 'manual', headers: { accept: 'application/json' } },
      { ...(opts.egress ?? {}), timeoutMs: opts.timeoutMs ?? 5_000, maxResponseBytes: 1024 * 1024 },
    );
    if (!r.ok) {
      await discardBody(r);
      return { ok: false, error: OLLAMA_PROBE_FAILED };
    }
    const body = (await r.json()) as OllamaTagsResponse;
    if (!body || !Array.isArray(body.models)) return { ok: false, error: OLLAMA_PROBE_FAILED };
    const models = body.models
      .map((m) => m?.name ?? m?.model)
      .filter((n): n is string => typeof n === 'string' && n.length > 0 && n.length <= 256)
      .slice(0, 500);
    return { ok: true, endpoint, models, rawCount: body.models.length };
  } catch (e) {
    if (e instanceof UnsafeEgressError) return { ok: false, error: e.message };
    if (e instanceof SafeFetchError && e.code === 'TIMEOUT') {
      return { ok: false, error: `${OLLAMA_PROBE_FAILED} (timed out)` };
    }
    return { ok: false, error: OLLAMA_PROBE_FAILED };
  }
}
