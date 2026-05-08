import { Controller, Param, Req, Res, Get } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunService } from './run.service.js';
import { EventlogService } from '../../common/eventlog.service.js';

@Controller('v1/orgs/:slug/projects/:projectSlug/runs/:runId/timeline')
export class TimelineSseController {
  constructor(private runs: RunService, private elSvc: EventlogService) {}

  @Get('stream')
  async stream(@Param('runId') runId: string, @Req() req: Request, @Res() res: Response) {
    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    const lastEventId = req.header('last-event-id') ?? undefined;

    // 1. Backfill from durable log up to "now".
    const backfill = await this.runs.timeline(runId, lastEventId);
    for (const e of backfill) {
      sendEvent(res, e);
    }

    // 2. Subscribe to live updates.
    const unsubscribe = await this.elSvc.pubsubHandle().subscribe(`run:${runId}`, (msg) => {
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
