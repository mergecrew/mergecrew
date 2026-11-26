/**
 * Minimal in-memory stand-in for the Prisma surface the auth/MFA/invite
 * services use. Supports equality, null, `{ gt, lt }`, and `OR` filters,
 * `{ increment }` updates, and `select` (shallow). Relation filters are
 * ignored. Good enough for unit tests; not a Prisma emulator.
 */
import { randomUUID } from 'node:crypto';

type Row = Record<string, any>;

function cmp(v: any): any {
  return v instanceof Date ? v.getTime() : v;
}

function matchValue(actual: any, cond: any): boolean {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date) return cmp(actual) === cond.getTime();
  if (typeof cond === 'object' && !Array.isArray(cond)) {
    if ('gt' in cond && !(actual !== null && actual !== undefined && cmp(actual) > cmp(cond.gt))) return false;
    if ('lt' in cond && !(actual !== null && actual !== undefined && cmp(actual) < cmp(cond.lt))) return false;
    if ('equals' in cond && actual !== cond.equals) return false;
    return true;
  }
  return actual === cond;
}

export function matches(row: Row, where: Row | undefined, relations: string[] = []): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w, relations))) return false;
      continue;
    }
    if (k === 'NOT') {
      if (matches(row, cond as Row, relations)) return false;
      continue;
    }
    if (relations.includes(k)) continue;
    // Compound unique key, e.g. organizationId_email: { organizationId, email }.
    if (k.includes('_') && cond && typeof cond === 'object' && !(cond instanceof Date) && !('gt' in cond) && !('lt' in cond)) {
      if (!matches(row, cond as Row, relations)) return false;
      continue;
    }
    if (!matchValue(row[k], cond)) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof Uint8Array) && 'increment' in v) {
      row[k] = (row[k] ?? 0) + (v as { increment: number }).increment;
    } else {
      row[k] = v;
    }
  }
}

function pick(row: Row | null, select?: Row): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
  return out;
}

class Table {
  rows: Row[] = [];
  /** Resolves `include: { relation: ... }` for findFirst (set per table). */
  includeResolver?: (row: Row, include: Row) => Row;
  constructor(
    private defaults: () => Row = () => ({}),
    private relations: string[] = [],
  ) {}

  findUnique = async (args: { where: Row; select?: Row }) =>
    pick(this.rows.find((r) => matches(r, args.where, this.relations)) ?? null, args.select);
  findFirst = async (args: { where?: Row; select?: Row; include?: Row } = {}) => {
    const row = pick(this.rows.find((r) => matches(r, args.where, this.relations)) ?? null, args.select);
    if (row && args.include && this.includeResolver) return this.includeResolver(row, args.include);
    return row;
  };
  findMany = async (args: { where?: Row; select?: Row } = {}) =>
    this.rows.filter((r) => matches(r, args.where, this.relations)).map((r) => pick(r, args.select)!);
  count = async (args: { where?: Row } = {}) =>
    this.rows.filter((r) => matches(r, args.where, this.relations)).length;
  create = async (args: { data: Row; select?: Row }) => {
    const row = { ...this.defaults(), ...args.data };
    this.rows.push(row);
    return pick(row, args.select)!;
  };
  createMany = async (args: { data: Row[] }) => {
    for (const d of args.data) this.rows.push({ ...this.defaults(), ...d });
    return { count: args.data.length };
  };
  update = async (args: { where: Row; data: Row; select?: Row }) => {
    const row = this.rows.find((r) => matches(r, args.where, this.relations));
    if (!row) throw new Error('record not found');
    applyData(row, args.data);
    return pick(row, args.select)!;
  };
  updateMany = async (args: { where: Row; data: Row }) => {
    const hit = this.rows.filter((r) => matches(r, args.where, this.relations));
    for (const r of hit) applyData(r, args.data);
    return { count: hit.length };
  };
  deleteMany = async (args: { where?: Row } = {}) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, args.where, this.relations));
    return { count: before - this.rows.length };
  };
  upsert = async (args: { where: Row; create: Row; update: Row }) => {
    const row = this.rows.find((r) => matches(r, args.where, this.relations));
    if (row) {
      applyData(row, args.update);
      return { ...row };
    }
    return this.create({ data: args.create });
  };
}

export function createFakeDb() {
  const db = {
    user: new Table(() => ({
      id: randomUUID(),
      name: null,
      avatarUrl: null,
      mfaSecretCiphertext: null,
      mfaPendingCiphertext: null,
      mfaEnrolledAt: null,
      mfaLastUsedStep: null,
      mfaFailedAttempts: 0,
      mfaLockedUntil: null,
      tokenVersion: 0,
    })),
    userMfaRecoveryCode: new Table(() => ({ id: randomUUID() })),
    authVerificationToken: new Table(),
    orgInvitation: new Table(() => ({ id: randomUUID(), createdAt: new Date() }), ['organization']),
    membership: new Table(() => ({ id: randomUUID(), createdAt: new Date() })),
    auditLogEntry: new Table(() => ({ id: randomUUID() })),
    organization: new Table(() => ({ id: randomUUID(), deletedAt: null })),
  };
  db.orgInvitation.includeResolver = (row, include) =>
    include.organization ? { ...row, organization: db.organization.rows.find((o) => o.id === row.organizationId) } : row;
  const prisma = {
    withSystem: async <T>(fn: (tx: any) => Promise<T>) => fn(db),
    withTenant: async <T>(_org: string, fn: (tx: any) => Promise<T>) => fn(db),
    client: () => db,
  };
  return { db, prisma: prisma as any };
}

/** TenantContextService stand-in. */
export function fakeTenant(ctx: { userId: string; tenant?: Record<string, any> } | undefined) {
  return {
    user: () => ctx,
    current: () => ctx?.tenant,
    require: () => {
      if (!ctx?.tenant) throw new Error('TenantContext required but not set');
      return ctx.tenant;
    },
    requireUser: () => {
      if (!ctx) throw new Error('UserContext required but not set');
      return ctx;
    },
  } as any;
}
