import type { AnySkill } from '../types.js';

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
  async execute(input: any, _ctx) {
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

export const webSkills: AnySkill[] = [webFetchUrl, webScreenshotUrl, webLighthouse];
