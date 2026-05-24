import { createHash, randomBytes } from 'node:crypto';
import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

/**
 * Runner-agent enrollment (V2.af / #765 / ADR-0004).
 *
 * Token shape:   mca_<orgSlug>_<26 base32 chars>
 * Storage:       only the sha256(token) hex is persisted.
 * Lifecycle:     created via the org-scoped admin endpoint; one-shot reveal;
 *                revoked via the admin endpoint (sets revokedAt).
 * Auth:          the runner-agent's public endpoints (e.g. /hello) match the
 *                Bearer header by hashing and looking up by tokenHash.
 */
export const RUNNER_AGENT_TOKEN_PREFIX = 'mca_';
export const RUNNER_AGENT_TOKEN_SECRET_LENGTH = 26;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface IssuedRunnerAgent {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  /** Plaintext token. Returned ONCE on creation; never again. */
  token: string;
}

export interface RunnerAgentSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  agentVersion: string | null;
}

export interface AgentIdentity {
  agentId: string;
  organizationId: string;
  organizationSlug: string;
  agentName: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generates a 26-char base32 secret (~130 bits of entropy). Uses
 * `randomBytes` for cryptographic randomness; the loop just maps each
 * byte mod 32 into the base32 alphabet. Bias from `% 32` on a uniform
 * byte is negligible for this length.
 */
function generateSecret(): string {
  const out: string[] = [];
  const buf = randomBytes(RUNNER_AGENT_TOKEN_SECRET_LENGTH);
  for (let i = 0; i < RUNNER_AGENT_TOKEN_SECRET_LENGTH; i++) {
    out.push(BASE32_ALPHABET[buf[i]! & 0x1f]!);
  }
  return out.join('');
}

@Injectable()
export class RunnerAgentService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  /**
   * Issue a new agent + return the plaintext token exactly once. The
   * caller must be an org admin (guard enforced at the controller).
   * Caller-supplied `name` is a free-form display label (e.g. "homelab-1").
   */
  async issue(input: { name: string }): Promise<IssuedRunnerAgent> {
    const t = this.tenant.require();
    const secret = generateSecret();
    const token = `${RUNNER_AGENT_TOKEN_PREFIX}${t.organizationSlug}_${secret}`;
    const tokenHash = hashToken(token);
    // 14-char display prefix is enough to distinguish agents in the UI
    // without leaking enough to brute-force the rest. `mca_<slug>_<6>`
    // takes the first 6 base32 chars of the secret.
    const prefixLen = `${RUNNER_AGENT_TOKEN_PREFIX}${t.organizationSlug}_`.length + 6;
    const displayPrefix = token.slice(0, prefixLen);

    const row = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.runnerAgent.create({
        data: {
          organizationId: t.organizationId,
          name: input.name,
          tokenHash,
          prefix: displayPrefix,
          createdByUserId: t.userId,
        },
      }),
    );

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'runnerAgent.created',
          target: { runnerAgentId: row.id },
          metadata: { name: row.name, prefix: row.prefix },
        },
      }),
    );

    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.createdAt,
      token,
    };
  }

  async list(): Promise<RunnerAgentSummary[]> {
    const t = this.tenant.require();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.runnerAgent.findMany({
        where: { organizationId: t.organizationId },
        orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      revokedAt: r.revokedAt,
      agentVersion: r.agentVersion,
    }));
  }

  async revoke(id: string): Promise<void> {
    const t = this.tenant.require();
    const found = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.runnerAgent.findFirst({ where: { id, organizationId: t.organizationId } }),
    );
    if (!found) throw new NotFoundException();
    if (found.revokedAt) return;

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.runnerAgent.update({
        where: { id },
        data: { revokedAt: new Date() },
      }),
    );

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'runnerAgent.revoked',
          target: { runnerAgentId: id },
          metadata: { name: found.name, prefix: found.prefix },
        },
      }),
    );
  }

  /**
   * Authenticate a bearer token from the runner-agent's outbound calls
   * (`/v1/runner-agent/*`). Returns the agent identity on hit + bumps
   * `lastSeenAt`. Throws 401 on any miss (unknown / revoked).
   *
   * Bypasses RLS via `withSystem` because the org isn't known until
   * after the lookup — every subsequent query in the caller is expected
   * to switch to `withTenant(agent.organizationId, …)`.
   */
  async resolveAgent(bearer: string, agentVersion?: string): Promise<AgentIdentity> {
    if (!bearer.startsWith(RUNNER_AGENT_TOKEN_PREFIX)) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
    }
    const tokenHash = hashToken(bearer);
    const row = await this.prisma.withSystem((tx) =>
      tx.runnerAgent.findUnique({
        where: { tokenHash },
        include: { organization: { select: { slug: true } } },
      }),
    );
    if (!row || row.revokedAt) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED' });
    }

    // Fire-and-forget `lastSeenAt` (and optional version) bump. Failure
    // must not block the request — a transient write error would
    // poison every poll/hello otherwise.
    void this.prisma
      .withSystem((tx) =>
        tx.runnerAgent.update({
          where: { id: row.id },
          data: {
            lastSeenAt: new Date(),
            ...(agentVersion ? { agentVersion } : {}),
          },
        }),
      )
      .catch(() => {});

    return {
      agentId: row.id,
      organizationId: row.organizationId,
      organizationSlug: row.organization.slug,
      agentName: row.name,
    };
  }
}
