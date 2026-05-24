import type {
  ExecOpts,
  ExecResult,
  SandboxDriver,
  SandboxHandle,
  SandboxStartOpts,
} from './types.js';

/**
 * `SandboxDriver` implementation that marshals every operation over
 * HTTPS to the deployment-side mediator, which in turn streams the op
 * to a BYO runner-agent for local execution. See ADR-0009.
 *
 * The driver itself is transport-agnostic — it does not talk to the
 * agent directly. It POSTs to the deployment API; the API matches the
 * op to an attached agent for the same `stepId` via the long-poll
 * sandbox-ops queue (lands in a later PR). This keeps the agent
 * behind NAT (outbound HTTPS only) and lets the driver be tested
 * without any agent or queue infrastructure.
 *
 * Each method is one POST. The HttpClient is injected so production
 * code can use `fetch` and tests can use a fake.
 */
export interface HttpDriverDeps {
  /**
   * Mediator base URL — e.g. `https://api.mergecrew.local`. The
   * driver appends `/v1/runner-agent/sandbox-ops/<stepId>/<op>`.
   * `runStep` constructs one driver per step.
   */
  baseUrl: string;
  /**
   * Authentication header to send on every op. The supervisor mints
   * a short-lived token at job pickup; the mediator verifies it
   * before forwarding to the agent.
   */
  authToken: string;
  /**
   * The step this driver is bound to. Every op carries the stepId
   * implicitly via the URL so the mediator can route to the right
   * agent.
   */
  stepId: string;
  /**
   * Pluggable HTTP transport for tests. `fetch` in production.
   */
  fetcher?: typeof fetch;
  /**
   * Per-op timeout. Hard ceiling on how long a single sandbox op
   * can take. Defaults to 10 minutes — matches the build timeout
   * elsewhere in the codebase.
   */
  opTimeoutMs?: number;
}

const DEFAULT_OP_TIMEOUT_MS = 10 * 60_000;

interface HandleEnvelope {
  id: string;
  driver: string;
  workspacePath: string;
}

interface OpEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: { message: string; kind?: string };
}

export class HttpSandboxDriver implements SandboxDriver {
  readonly name = 'http';
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly stepId: string;
  private readonly fetcher: typeof fetch;
  private readonly opTimeoutMs: number;

  constructor(deps: HttpDriverDeps) {
    if (!deps.baseUrl) throw new Error('HttpSandboxDriver: baseUrl required');
    if (!deps.authToken) throw new Error('HttpSandboxDriver: authToken required');
    if (!deps.stepId) throw new Error('HttpSandboxDriver: stepId required');
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.authToken = deps.authToken;
    this.stepId = deps.stepId;
    this.fetcher = deps.fetcher ?? fetch;
    this.opTimeoutMs = deps.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
  }

  async start(opts: SandboxStartOpts): Promise<SandboxHandle> {
    const env = await this.post<HandleEnvelope>('start', opts);
    return { id: env.id, driver: env.driver, workspacePath: env.workspacePath };
  }

  async exec(_handle: SandboxHandle, opts: ExecOpts): Promise<ExecResult> {
    // The handle isn't serialized — the mediator pairs the op with
    // the agent's active handle for this stepId. If the agent has
    // multiple handles (it shouldn't for v1), the agent itself
    // disambiguates.
    return this.post<ExecResult>('exec', {
      cmd: opts.cmd,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
    });
  }

  async readFile(_handle: SandboxHandle, relPath: string): Promise<Buffer> {
    const r = await this.post<{ base64: string }>('readFile', { relPath });
    return Buffer.from(r.base64, 'base64');
  }

  async writeFile(
    _handle: SandboxHandle,
    relPath: string,
    data: Buffer | string,
  ): Promise<void> {
    const base64 = typeof data === 'string'
      ? Buffer.from(data).toString('base64')
      : data.toString('base64');
    await this.post<{ ok: true }>('writeFile', { relPath, base64 });
  }

  async kill(_handle: SandboxHandle, signal?: NodeJS.Signals): Promise<void> {
    await this.post<{ ok: true }>('kill', { signal });
  }

  async stop(_handle: SandboxHandle): Promise<void> {
    await this.post<{ ok: true }>('stop', {});
  }

  private async post<T>(op: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}/v1/runner-agent/sandbox-ops/${encodeURIComponent(this.stepId)}/${op}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opTimeoutMs);
    try {
      const res = await this.fetcher(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `HttpSandboxDriver.${op}: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
        );
      }
      const envelope = (await res.json()) as OpEnvelope<T>;
      if (envelope.ok === false) {
        const e = envelope.error ?? { message: 'unknown agent error' };
        const err = new Error(`HttpSandboxDriver.${op}: ${e.message}`);
        (err as any).kind = e.kind;
        throw err;
      }
      if (envelope.result === undefined) {
        throw new Error(`HttpSandboxDriver.${op}: empty result envelope`);
      }
      return envelope.result;
    } finally {
      clearTimeout(t);
    }
  }
}
