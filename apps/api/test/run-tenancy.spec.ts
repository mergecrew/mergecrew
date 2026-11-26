jest.mock('@mergecrew/db', () => ({ withTenant: jest.fn(), withSystem: jest.fn(), getPrisma: jest.fn() }));

import { NotFoundError } from '@mergecrew/domain';
import { RunService } from '../src/modules/run/run.service';
import { TimelineSseController } from '../src/modules/run/timeline-sse.controller';
import type { EventlogService } from '../src/common/eventlog.service';
import type { QueueService } from '../src/common/queue.service';
import type { TelemetryService } from '../src/common/telemetry.service';
import { ORG_A, ORG_B, fakePrisma, fakeTenant, matches } from './helpers';

const RUN_B = '33333333-3333-4333-8333-333333333333';
const RUN_A = '44444444-4444-4444-8444-444444444444';

const runs = [
  { id: RUN_B, organizationId: ORG_B, projectId: 'p-b', project: { slug: 'web', organizationId: ORG_B, deletedAt: null } },
  { id: RUN_A, organizationId: ORG_A, projectId: 'p-a', project: { slug: 'web', organizationId: ORG_A, deletedAt: null } },
];

function setup() {
  const tx = {
    dailyRun: {
      findFirst: jest.fn(async ({ where }: any) => runs.find((r) => matches(r, where)) ?? null),
      update: jest.fn(async () => ({})),
    },
  };
  const subscribe = jest.fn(async () => async () => {});
  const elSvc = {
    pubsubHandle: () => ({ subscribe, publish: jest.fn(async () => 0) }),
    eventlog: { replayRun: jest.fn(async () => []), emit: jest.fn(async () => ({})) },
  } as unknown as EventlogService;
  const svc = new RunService(
    fakePrisma(tx),
    fakeTenant({ organizationId: ORG_A, role: 'operator' }),
    { get: () => ({ add: jest.fn(async () => ({})) }) } as unknown as QueueService,
    elSvc,
    { emit: jest.fn() } as unknown as TelemetryService,
  );
  return { svc, tx, subscribe, elSvc };
}

function fakeRes() {
  return {
    set: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
  } as any;
}

describe('timeline SSE tenant scoping', () => {
  it("404s on another org's run id and never subscribes to its channel", async () => {
    const { svc, subscribe, elSvc } = setup();
    const ctrl = new TimelineSseController(svc, elSvc);
    const res = fakeRes();
    await expect(
      ctrl.stream('web', RUN_B, undefined, { header: () => undefined, on: jest.fn() } as any, res),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(subscribe).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
  });

  it('404s when the run exists in the org but under a different project slug', async () => {
    const { svc, subscribe, elSvc } = setup();
    const ctrl = new TimelineSseController(svc, elSvc);
    await expect(
      ctrl.stream('other', RUN_A, undefined, { header: () => undefined, on: jest.fn() } as any, fakeRes()),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('subscribes only after verifying the run belongs to org + project', async () => {
    const { svc, subscribe, elSvc } = setup();
    const ctrl = new TimelineSseController(svc, elSvc);
    const req = { header: () => undefined, on: jest.fn() } as any;
    await ctrl.stream('web', RUN_A, undefined, req, fakeRes());
    expect(subscribe).toHaveBeenCalledWith(`run:${RUN_A}`, expect.any(Function));
    // Clean up the heartbeat interval registered by the controller.
    const onClose = req.on.mock.calls.find((c: any[]) => c[0] === 'close')?.[1];
    await onClose?.();
  });
});

describe('run mutations are org scoped', () => {
  it("cannot cancel another org's run", async () => {
    const { svc, tx } = setup();
    await expect(svc.cancel(RUN_B, 'web')).rejects.toBeInstanceOf(NotFoundError);
    expect(tx.dailyRun.update).not.toHaveBeenCalled();
  });

  it('cancel carries an explicit organizationId predicate', async () => {
    const { svc, tx } = setup();
    await svc.cancel(RUN_A, 'web');
    expect(tx.dailyRun.update.mock.calls[0]![0].where).toEqual({ id: RUN_A, organizationId: ORG_A });
  });

  it("cannot replay another org's run timeline", async () => {
    const { svc, elSvc } = setup();
    await expect(svc.timeline(RUN_B, undefined, 'web')).rejects.toBeInstanceOf(NotFoundError);
    expect(elSvc.eventlog.replayRun).not.toHaveBeenCalled();
  });
});
