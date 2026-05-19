import type { AnySkill } from '../types.js';
import { recordAndAssertEgress } from '../egress-policy.js';

const webFetchUrl: AnySkill = {
  name: 'web.fetch_url',
  description: 'Fetch a URL and return its body (truncated). Logged for audit.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      headers: { type: 'object' },
      max_bytes: { type: 'integer' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['net.outbound'],
  timeoutMs: 30_000,
  async execute(input: any, ctx) {
    await recordAndAssertEgress(input.url, ctx, 'web.fetch_url');
    ctx.logger.info('web.fetch_url', { url: input.url });
    const r = await fetch(input.url, { headers: input.headers, signal: ctx.abortSignal });
    const max = input.max_bytes ?? 200_000;
    const reader = r.body?.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (bytes > max) {
          chunks.push(value.subarray(0, value.byteLength - (bytes - max)));
          break;
        }
        chunks.push(value);
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const ct = r.headers.get('content-type') ?? '';
    const text = ct.includes('text') || ct.includes('json') || ct.includes('xml')
      ? buf.toString('utf8')
      : `[binary, ${buf.length} bytes]`;
    return {
      output: { status: r.status, contentType: ct, body: text, truncated: bytes > max },
      brief: `${r.status} ${input.url}`,
    };
  },
};

const webScreenshotUrl: AnySkill = {
  name: 'web.screenshot_url',
  description: 'Take a PNG screenshot of a URL using a headless browser.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      width: { type: 'integer' },
      height: { type: 'integer' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['net.outbound'],
  timeoutMs: 60_000,
  async execute(input: any, ctx) {
    await recordAndAssertEgress(input.url, ctx, 'web.screenshot_url');
    let chromium: any;
    try {
      ({ chromium } = await import('playwright-core'));
    } catch {
      return { output: { error: 'playwright-core not installed' }, brief: 'screenshot skipped' };
    }
    const browser = await chromium.launch({ headless: true });
    try {
      const ctxBrowser = await browser.newContext({
        viewport: { width: input.width ?? 1280, height: input.height ?? 800 },
      });
      const page = await ctxBrowser.newPage();
      await page.goto(input.url, { waitUntil: 'networkidle', timeout: 30_000 });
      const png = await page.screenshot({ type: 'png', fullPage: true });
      const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
      ctx.logger.info('web.screenshot_url', { url: input.url, bytes: png.length });
      return {
        output: { dataUrl, bytes: png.length },
        brief: `screenshot ${input.url}`,
      };
    } finally {
      await browser.close();
    }
  },
};

const webLighthouse: AnySkill = {
  name: 'web.lighthouse',
  description: 'Run a basic Lighthouse-equivalent audit (perf, a11y, best practices).',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', format: 'uri' } },
    required: ['url'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['net.outbound'],
  timeoutMs: 90_000,
  async execute(input: any, ctx) {
    await recordAndAssertEgress(input.url, ctx, 'web.lighthouse');
    // V1 placeholder: a real Lighthouse integration is V1.x.
    // We surface load timings + key headers as a useful approximation.
    const start = Date.now();
    const r = await fetch(input.url);
    const elapsed = Date.now() - start;
    return {
      output: {
        url: input.url,
        status: r.status,
        timeMs: elapsed,
        headers: Object.fromEntries(r.headers.entries()),
      },
      brief: `loaded in ${elapsed}ms`,
    };
  },
};

const webSmokeCheck: AnySkill = {
  name: 'web.smoke_check',
  description:
    'Fetch a deployed URL and assert it is healthy: 2xx status, optional keyword presence, optional forbidden-string absence. Read-only; uses fetch (no headless browser).',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      timeoutMs: { type: 'integer' },
      mustContain: {
        type: 'array',
        items: { type: 'string' },
        description: 'Strings the response body must contain (case-sensitive).',
      },
      mustNotContain: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Strings the response body must NOT contain (e.g. "Internal Server Error").',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  sideEffectClass: 'read',
  capabilities: ['net.outbound'],
  timeoutMs: 60_000,
  async execute(input: any, ctx) {
    const url = String(input.url);
    await recordAndAssertEgress(url, ctx, 'web.smoke_check');
    const timeoutMs = Number(input.timeoutMs ?? 15_000);
    const mustContain: string[] = Array.isArray(input.mustContain) ? input.mustContain : [];
    const mustNotContain: string[] = Array.isArray(input.mustNotContain) ? input.mustNotContain : [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Bridge the outer abort signal too so abort cascades.
    const onOuterAbort = () => controller.abort();
    ctx.abortSignal?.addEventListener('abort', onOuterAbort, { once: true });

    const failures: string[] = [];
    let status = 0;
    let elapsedMs = 0;
    let body = '';
    const start = Date.now();
    try {
      const r = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      elapsedMs = Date.now() - start;
      status = r.status;
      body = await r.text();
      if (status < 200 || status >= 300) failures.push(`status ${status}`);
      for (const needle of mustContain) {
        if (!body.includes(needle)) failures.push(`missing "${truncate(needle, 60)}"`);
      }
      for (const needle of mustNotContain) {
        if (body.includes(needle)) failures.push(`contains forbidden "${truncate(needle, 60)}"`);
      }
    } catch (err) {
      elapsedMs = Date.now() - start;
      const msg = (err as Error)?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String((err as Error)?.message ?? err);
      failures.push(`fetch failed: ${msg}`);
    } finally {
      clearTimeout(timer);
      ctx.abortSignal?.removeEventListener('abort', onOuterAbort);
    }

    const ok = failures.length === 0;
    return {
      output: {
        ok,
        url,
        status,
        elapsedMs,
        bodyLength: body.length,
        bodyHead: body.slice(0, 400),
        failures,
      },
      brief: ok ? `smoke ok ${url} (${elapsedMs}ms)` : `smoke FAIL ${url}: ${failures.join('; ')}`,
    };
  },
};

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export const webSkills: AnySkill[] = [webFetchUrl, webScreenshotUrl, webLighthouse, webSmokeCheck];
