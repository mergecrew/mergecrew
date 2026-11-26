import { Controller, Param, Query, Req, Res, Get, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunService } from './run.service.js';
import { EventlogService } from '../../common/eventlog.service.js';
import { RoleGuard } from '../../common/role.guard.js';

@Controller('v1/orgs/:slug/projects/:projectSlug/runs/:runId/timeline')
@UseGuards(RoleGuard)
export class TimelineSseController {
  constructor(private runs: RunService, private elSvc: EventlogService) {}

  @Get('stream')
  async stream(
    @Param('projectSlug') projectSlug: string,
    @Param('runId') runId: string,
    @Query('lastEventId') lastEventIdQuery: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // 0. Ownership check BEFORE anything is streamed. The Redis channel
    // below has no RLS, so the run must be proven to belong to the
    // tenant org and the URL's project first — a foreign or unknown run
    // id is a plain 404 (thrown before headers are flushed so the
    // exception filter can still answer).
    const run = await this.runs.get(runId, projectSlug);

    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    // Prefer the standard SSE header that browsers set on auto-reconnect;
    // accept a query param fallback for clients (Node test scripts, native
    // EventSource without header support) that can't set the header.
    const lastEventId = req.header('last-event-id') ?? lastEventIdQuery ?? undefined;

    // 1. Backfill from durable log up to "now".
    const backfill = await this.runs.timeline(run.id, lastEventId, projectSlug);
    for (const e of backfill) {
      sendEvent(res, e);
    }

    // 2. Subscribe to live updates (only for the verified run id).
    const unsubscribe = await this.elSvc.pubsubHandle().subscribe(`run:${run.id}`, (msg) => {
      sendEvent(res, msg as any);
    });

    // 3. Heartbeat every 15s so intermediaries don't time out the connection.
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ now: new Date().toISOString() })}\n\n`);
      } catch {
        /* ignore */
      }
    }, 15_000);

    req.on('close', async () => {
      clearInterval(heartbeat);
      try {
        await unsubscribe();
      } catch {
        /* ignore */
      }
    });
  }
}

function sendEvent(res: Response, e: any) {
  try {
    res.write(`id: ${e.id}\nevent: timeline\ndata: ${JSON.stringify(e)}\n\n`);
  } catch {
    /* ignore */
  }
}
