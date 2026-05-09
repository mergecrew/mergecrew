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
 */
export async function probeOllama(
  endpoint: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OllamaProbeResult | OllamaProbeError> {
  const url = endpoint.replace(/\/+$/, '') + '/api/tags';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 5_000);
  const composed = anySignal([opts.signal, ac.signal].filter(Boolean) as AbortSignal[]);

  try {
    const r = await fetch(url, { signal: composed });
    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status} from ${url}` };
    }
    const body = (await r.json()) as OllamaTagsResponse;
    const models = (body.models ?? [])
      .map((m) => m.name ?? m.model)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    return { ok: true, endpoint, models, rawCount: body.models?.length ?? 0 };
  } catch (e: any) {
    return {
      ok: false,
      error: ac.signal.aborted ? `timeout after ${opts.timeoutMs ?? 5_000}ms` : String(e?.message ?? e),
    };
  } finally {
    clearTimeout(timer);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
