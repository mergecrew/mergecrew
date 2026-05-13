// Catalog of routes captured by `pnpm screenshots`.
//
// `auth: 'public'` runs in a fresh, cookie-less browser context so the public
// landing page is reachable. Everything else uses the auto-login session.

export type RouteSpec = {
  name: string;
  path: string;
  auth: 'public' | 'auto-login';
  waitForSelector?: string;
  description: string;
};

const ORG = process.env.MERGECREW_SCREENSHOT_ORG ?? 'demo';
const PROJECT = process.env.MERGECREW_SCREENSHOT_PROJECT ?? 'acme';

export const ROUTES: RouteSpec[] = [
  {
    name: '01-landing',
    path: '/',
    auth: 'public',
    description: 'Marketing landing page (logged-out). Set MERGECREW_DEV_AUTO_LOGIN=false on the web app for this to render — otherwise the BFF redirects into the app.',
  },
  {
    name: '02-today',
    path: `/orgs/${ORG}`,
    auth: 'auto-login',
    description: 'Today page — the post-login hub with the welcome card and sample-run CTA.',
  },
  {
    name: '03-onboarding',
    path: `/orgs/${ORG}/onboarding`,
    auth: 'auto-login',
    description: 'Five-step onboarding wizard (provider → project → repo → deploy target → lifecycle).',
  },
  {
    name: '04-projects',
    path: `/orgs/${ORG}/projects`,
    auth: 'auto-login',
    description: 'Org-level projects list.',
  },
  {
    name: '05-project-home',
    path: `/orgs/${ORG}/projects/${PROJECT}`,
    auth: 'auto-login',
    description: 'Project landing — most-recent run, agents, gates at a glance.',
  },
  {
    name: '06-timeline',
    path: `/orgs/${ORG}/projects/${PROJECT}/timeline`,
    auth: 'auto-login',
    description: 'Live run timeline. The hero shot: agents working in real time via SSE.',
  },
  {
    name: '07-digest',
    path: `/orgs/${ORG}/projects/${PROJECT}/digest`,
    auth: 'auto-login',
    description: 'Daily digest — what the agents produced today, ready for human approval.',
  },
  {
    name: '08-changesets',
    path: `/orgs/${ORG}/projects/${PROJECT}/changesets`,
    auth: 'auto-login',
    description: 'Changesets list — every agent-generated diff.',
  },
  {
    name: '09-agents',
    path: `/orgs/${ORG}/projects/${PROJECT}/agents`,
    auth: 'auto-login',
    description: 'Agents card — per-agent cost, token usage, retry rate.',
  },
  {
    name: '10-lifecycle',
    path: `/orgs/${ORG}/projects/${PROJECT}/lifecycle`,
    auth: 'auto-login',
    description: 'Lifecycle template editor (mergecrew.yaml).',
  },
  {
    name: '11-costs',
    path: `/orgs/${ORG}/costs`,
    auth: 'auto-login',
    description: 'Org cost ledger — every model turn with usd estimate.',
  },
  {
    name: '12-inbox',
    path: `/orgs/${ORG}/inbox`,
    auth: 'auto-login',
    description: 'Inbox — pending approvals and reviewer asks.',
  },
];
