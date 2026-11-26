import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OrgService } from './org.service';

const ORG_ID = '00000000-0000-0000-0000-0000000000a1';
const WEB_APP_DIR = join(__dirname, '../../../../web/src/app');

// Resolves a web path to a Next.js app-router page, following route groups
// `(group)` and dynamic segments `[param]` the same way the router does.
function routeExists(dir: string, segments: string[]): boolean {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const group of entries.filter((e) => /^\(.+\)$/.test(e.name))) {
    if (routeExists(join(dir, group.name), segments)) return true;
  }
  if (segments.length === 0) return existsSync(join(dir, 'page.tsx'));
  const [head, ...rest] = segments;
  const candidates = entries.filter((e) => e.name === head || /^\[[^.\]]+\]$/.test(e.name));
  return candidates.some((e) => routeExists(join(dir, e.name), rest));
}

function makeService(project: { slug: string } | null) {
  const tx = {
    llmProvider: { count: async () => 0 },
    runnerProfile: { findUnique: async () => null },
    project: {
      findMany: async () =>
        project
          ? [{ id: 'p1', slug: project.slug, connectedRepo: null, deployTargets: [], promotionStrategy: null }]
          : [],
    },
  };
  const prisma = { withTenant: async (_id: string, fn: (db: any) => Promise<unknown>) => fn(tx) } as any;
  const tenant = { require: () => ({ organizationId: ORG_ID }) } as any;
  return new OrgService(prisma, tenant, {} as any);
}

describe('OrgService.onboarding actionUrls (#867)', () => {
  it.each([
    ['a fresh org', null],
    ['an org with a project', { slug: 'shop' }],
  ])('every step links to an existing web route for %s', async (_label, project) => {
    const { steps } = await makeService(project).onboarding('acme');
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const path = step.actionUrl.split(/[?#]/)[0];
      expect({ key: step.key, path, exists: routeExists(WEB_APP_DIR, path.split('/').filter(Boolean)) }).toEqual({
        key: step.key,
        path,
        exists: true,
      });
    }
  });
});
