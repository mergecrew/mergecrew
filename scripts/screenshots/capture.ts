/* eslint-disable no-console */
/**
 * Capture screenshots of the Mergecrew web app for docs + marketing.
 *
 *   pnpm screenshots                          # default: all routes, desktop, light + dark
 *   pnpm screenshots -- --routes 06-timeline  # one route
 *   pnpm screenshots -- --viewport mobile     # mobile only
 *   pnpm screenshots -- --theme light         # skip dark variant
 *   pnpm screenshots -- --url http://staging  # against a remote env
 *
 * Output: docs/assets/screenshots/<name>.<theme>.<viewport>.png
 *
 * Requires playwright + a chromium binary:
 *
 *   pnpm install
 *   pnpm exec playwright install chromium
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext } from 'playwright';

import { ROUTES, type RouteSpec } from './routes';

type Viewport = 'desktop' | 'mobile';
type Theme = 'light' | 'dark';

const VIEWPORTS: Record<Viewport, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const args = parseArgs({
  options: {
    url: { type: 'string', default: process.env.MERGECREW_SCREENSHOT_URL ?? 'http://localhost:3000' },
    out: { type: 'string', default: resolve(process.cwd(), 'docs/assets/screenshots') },
    routes: { type: 'string' },
    viewport: { type: 'string', default: 'both' },
    theme: { type: 'string', default: 'both' },
    headed: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '20000' },
  },
}).values;

const baseUrl = args.url!.replace(/\/$/, '');
const outDir = args.out!;
const headless = !args.headed;
const timeoutMs = Number(args.timeout);
const viewports: Viewport[] =
  args.viewport === 'desktop' ? ['desktop'] : args.viewport === 'mobile' ? ['mobile'] : ['desktop', 'mobile'];
const themes: Theme[] =
  args.theme === 'light' ? ['light'] : args.theme === 'dark' ? ['dark'] : ['light', 'dark'];

const wanted = args.routes ? new Set(args.routes.split(',').map((s) => s.trim())) : null;
const routes: RouteSpec[] = wanted ? ROUTES.filter((r) => wanted.has(r.name)) : ROUTES;

if (routes.length === 0) {
  console.error(`No routes matched. Known names: ${ROUTES.map((r) => r.name).join(', ')}`);
  process.exit(1);
}

async function makeContext(browser: Browser, theme: Theme, viewport: Viewport): Promise<BrowserContext> {
  return browser.newContext({
    viewport: VIEWPORTS[viewport],
    colorScheme: theme,
    deviceScaleFactor: viewport === 'desktop' ? 2 : 3,
  });
}

async function captureOne(
  browser: Browser,
  route: RouteSpec,
  theme: Theme,
  viewport: Viewport,
): Promise<{ ok: true; bytes: number; file: string } | { ok: false; reason: string }> {
  const context = await makeContext(browser, theme, viewport);
  const page = await context.newPage();

  try {
    const url = `${baseUrl}${route.path}`;
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    if (!response) return { ok: false, reason: 'no response' };
    if (!response.ok() && response.status() !== 304) {
      return { ok: false, reason: `HTTP ${response.status()}` };
    }

    if (route.waitForSelector) {
      await page.waitForSelector(route.waitForSelector, { timeout: timeoutMs }).catch(() => {});
    }

    // Small breathing room for streaming UIs / SSE / fade-ins.
    await page.waitForTimeout(600);

    const file = join(outDir, `${route.name}.${theme}.${viewport}.png`);
    const buf = await page.screenshot({ fullPage: true, type: 'png' });
    await writeFile(file, buf);
    return { ok: true, bytes: buf.byteLength, file };
  } finally {
    await context.close();
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  console.log(`base=${baseUrl}  out=${outDir}  routes=${routes.length}  viewports=${viewports.join(',')}  themes=${themes.join(',')}`);
  const browser = await chromium.launch({ headless });

  let ok = 0;
  let failed = 0;

  try {
    for (const route of routes) {
      for (const theme of themes) {
        for (const viewport of viewports) {
          const label = `${pad(route.name, 18)} ${pad(`${theme}/${viewport}`, 16)}`;
          process.stdout.write(`  ${label} `);
          const t0 = Date.now();
          const result = await captureOne(browser, route, theme, viewport);
          const ms = Date.now() - t0;
          if (result.ok) {
            const kb = Math.round(result.bytes / 1024);
            console.log(`ok  ${kb}KB  ${ms}ms`);
            ok++;
          } else {
            console.log(`skip ${result.reason}  ${ms}ms`);
            failed++;
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\ncaptured ${ok}, skipped ${failed}, output ${outDir}`);
  if (ok === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
