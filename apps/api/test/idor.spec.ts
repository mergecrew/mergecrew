jest.mock('@mergecrew/db', () => ({
  withTenant: jest.fn(),
  withSystem: jest.fn(),
  getPrisma: jest.fn(),
  effectiveBaseBranch: jest.fn(),
}));
jest.mock('@mergecrew/adapters-vcs', () => ({ GitHubProvider: jest.fn(), getGitHubAppCredentials: jest.fn() }));

import { NotFoundError } from '@mergecrew/domain';
import { LlmService } from '../src/modules/llm/llm.service';
import { ChangesetCommentService } from '../src/modules/changeset/changeset-comment.service';
import { ChangesetService } from '../src/modules/changeset/changeset.service';
import { ApprovalService } from '../src/modules/approval/approval.service';
import type { CryptoService } from '../src/common/crypto.service';
import type { EventlogService } from '../src/common/eventlog.service';
import type { QueueService } from '../src/common/queue.service';
import { ORG_A, ORG_B, fakePrisma, fakeTenant, matches } from './helpers';

const tenantA = () => fakeTenant({ organizationId: ORG_A, role: 'admin' });
const crypto = { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s } as unknown as CryptoService;
const queue = { get: () => ({ add: jest.fn(async () => ({})) }) } as unknown as QueueService;
const elSvc = { eventlog: { emit: jest.fn(async () => ({})) } } as unknown as EventlogService;

function table(rows: Array<Record<string, any>>) {
  return {
    findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null),
    findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
    update: jest.fn(async ({ where }: any) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw new Error('P2025 record not found');
      return r;
    }),
    updateMany: jest.fn(async ({ where }: any) => ({ count: rows.filter((r) => matches(r, where)).length })),
    delete: jest.fn(async ({ where }: any) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw new Error('P2025 record not found');
      return r;
    }),
    deleteMany: jest.fn(async ({ where }: any) => ({ count: rows.filter((r) => matches(r, where)).length })),
    create: jest.fn(async ({ data }: any) => data),
  };
}

describe('LLM provider/profile IDOR', () => {
  const setup = () => {
    const tx = {
      llmProvider: table([{ id: 'prov-b', organizationId: ORG_B }]),
      llmProfile: table([{ id: 'prof-b', organizationId: ORG_B }]),
    };
    return { svc: new LlmService(fakePrisma(tx), tenantA(), crypto), tx };
  };

  it("org A admin cannot repoint org B's provider", async () => {
    const { svc, tx } = setup();
    await expect(svc.updateProvider('prov-b', { endpoint: 'https://x.example' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(tx.llmProvider.update).not.toHaveBeenCalled();
  });

  it("org A admin cannot delete org B's provider", async () => {
    const { svc, tx } = setup();
    await expect(svc.deleteProvider('prov-b')).rejects.toBeInstanceOf(NotFoundError);
    expect(tx.llmProvider.deleteMany.mock.calls[0]![0].where).toEqual({ id: 'prov-b', organizationId: ORG_A });
  });

  it("org A admin cannot update or delete org B's profile", async () => {
    const { svc, tx } = setup();
    await expect(svc.updateProfile('prof-b', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.deleteProfile('prof-b')).rejects.toBeInstanceOf(NotFoundError);
    expect(tx.llmProfile.update).not.toHaveBeenCalled();
  });
});

describe('changeset comments IDOR', () => {
  const setup = () => {
    const tx = {
      changeset: table([
        { id: 'cs-b', organizationId: ORG_B, project: { slug: 'web', organizationId: ORG_B, deletedAt: null } },
        { id: 'cs-a', organizationId: ORG_A, project: { slug: 'web', organizationId: ORG_A, deletedAt: null } },
      ]),
      changesetComment: table([
        { id: 'c-b', organizationId: ORG_B, changesetId: 'cs-b', userId: 'u' },
        { id: 'c-a', organizationId: ORG_A, changesetId: 'cs-a', userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      ]),
    };
    return { svc: new ChangesetCommentService(fakePrisma(tx), tenantA()), tx };
  };

  it("cannot list another org's changeset comments", async () => {
    const { svc, tx } = setup();
    await expect(svc.list('web', 'cs-b')).rejects.toBeInstanceOf(NotFoundError);
    expect(tx.changesetComment.findMany).not.toHaveBeenCalled();
  });

  it('cannot list comments through a different project slug', async () => {
    const { svc } = setup();
    await expect(svc.list('demo-saas', 'cs-a')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cannot edit/delete a comment that is not on the addressed changeset', async () => {
    const { svc, tx } = setup();
    await expect(svc.update('web', 'cs-a', 'c-b', { resolved: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.delete('web', 'cs-a', 'c-b')).rejects.toBeInstanceOf(NotFoundError);
    expect(tx.changesetComment.update).not.toHaveBeenCalled();
    expect(tx.changesetComment.delete).not.toHaveBeenCalled();
  });

  it('lists comments with explicit org + changeset predicates', async () => {
    const { svc, tx } = setup();
    await svc.list('web', 'cs-a');
    expect(tx.changesetComment.findMany.mock.calls[0]![0].where).toEqual({
      changesetId: 'cs-a',
      organizationId: ORG_A,
    });
  });
});

describe('changeset decisions + approvals are bound to the URL project', () => {
  it('a demo-project changeset cannot be decided via a non-demo slug', async () => {
    const tx = {
      changeset: table([
        { id: 'cs-demo', organizationId: ORG_A, project: { slug: 'demo-saas', organizationId: ORG_A, deletedAt: null } },
      ]),
      timelineEvent: table([]),
      decision: table([]),
    };
    const svc = new ChangesetService(fakePrisma(tx), tenantA(), queue, elSvc);
    await expect(svc.decide('cs-demo', 'promote', undefined, 'web')).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.rollback('cs-demo', 'web')).rejects.toBeInstanceOf(NotFoundError);
    expect(tx.decision.create).not.toHaveBeenCalled();
    expect(tx.changeset.update).not.toHaveBeenCalled();
  });

  it('an approval cannot be resolved via another project slug', async () => {
    const tx = {
      approvalRequest: table([
        {
          id: 'ar-demo',
          organizationId: ORG_A,
          resolvedAt: null,
          project: { slug: 'demo-saas', organizationId: ORG_A, deletedAt: null },
        },
      ]),
    };
    const svc = new ApprovalService(fakePrisma(tx), tenantA(), queue, elSvc);
    await expect(svc.resolve('ar-demo', 'approve', undefined, 'web')).rejects.toBeInstanceOf(NotFoundError);
    expect(tx.approvalRequest.update).not.toHaveBeenCalled();
  });
});
