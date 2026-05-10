import { createHash, randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { OrgRole } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';

export const API_KEY_PREFIX = 'mc_live_';

export interface IssuedApiKey {
  id: string;
  name: string;
  prefix: string;
  role: OrgRole;
  createdAt: Date;
  /** Plaintext token. Returned ONCE on creation; never again. */
  token: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  role: OrgRole;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Hash an API token for DB storage. The DB never holds a usable secret —
 * the plaintext is shown to the issuer once at creation, then discarded.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class ApiKeyService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
  ) {}

  async issue(input: { name: string; role?: OrgRole }): Promise<IssuedApiKey> {
    const t = this.tenant.require();
    const secret = randomBytes(32).toString('base64url');
    const token = `${API_KEY_PREFIX}${secret}`;
    const tokenHash = hashToken(token);
    // 12-char public-display prefix is enough to uniquely identify the key
    // in the UI without leaking enough to brute-force the rest.
    const displayPrefix = token.slice(0, API_KEY_PREFIX.length + 4);

    const created = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.apiKey.create({
        data: {
          organizationId: t.organizationId,
          name: input.name,
          tokenHash,
          prefix: displayPrefix,
          role: (input.role ?? 'operator') as any,
          createdByUserId: t.userId,
        },
      }),
    );

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'apiKey.created',
          target: { apiKeyId: created.id },
          metadata: { name: created.name, role: created.role, prefix: created.prefix },
        },
      }),
    );

    return {
      id: created.id,
      name: created.name,
      prefix: created.prefix,
      role: created.role as OrgRole,
      createdAt: created.createdAt,
      token,
    };
  }

  async list(): Promise<ApiKeySummary[]> {
    const t = this.tenant.require();
    const rows = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.apiKey.findMany({
        where: { organizationId: t.organizationId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      role: r.role as OrgRole,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
    }));
  }

  async revoke(id: string): Promise<void> {
    const t = this.tenant.require();
    const found = await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.apiKey.findFirst({ where: { id, organizationId: t.organizationId } }),
    );
    if (!found) throw new NotFoundException();
    if (found.revokedAt) return;

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } }),
    );

    await this.prisma.withTenant(t.organizationId, (tx) =>
      tx.auditLogEntry.create({
        data: {
          organizationId: t.organizationId,
          actorUserId: t.userId,
          action: 'apiKey.revoked',
          target: { apiKeyId: id },
          metadata: { name: found.name, prefix: found.prefix },
        },
      }),
    );
  }
}
