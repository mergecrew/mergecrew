'use client';

import { useEffect, useRef, useState } from 'react';

interface Ev {
  id: string;
  type: string;
  occurredAt: string;
  payload?: any;
  actor?: any;
}

export function LiveTimeline({ initial, streamUrl }: { initial: Ev[]; streamUrl: string }) {
  const [events, setEvents] = useState<Ev[]>(initial);
  const seen = useRef(new Set(initial.map((e) => e.id)));

  useEffect(() => {
    const es = new EventSource(streamUrl, { withCredentials: true });
    const onMsg = (ev: MessageEvent) => {
      try {
        const e = JSON.parse(ev.data) as Ev;
        if (seen.current.has(e.id)) return;
        seen.current.add(e.id);
        setEvents((prev) => [...prev, e]);
      } catch {
        /* ignore */
      }
    };
    es.addEventListener('timeline', onMsg as any);
    return () => {
      es.removeEventListener('timeline', onMsg as any);
      es.close();
    };
  }, [streamUrl]);

  return (
    <ol className="space-y-1">
      {events.map((e) => (
        <li key={e.id} className="flex gap-3 text-sm">
          <span className="text-zinc-400 w-20 shrink-0 font-mono">
            {new Date(e.occurredAt).toLocaleTimeString()}
          </span>
          <span className="font-mono text-xs text-zinc-500 w-44 shrink-0">{e.type}</span>
          <span className="text-zinc-800 dark:text-zinc-200">{briefFor(e)}</span>
        </li>
      ))}
    </ol>
  );
}

function briefFor(e: Ev): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'AGENT_TOOL_CALL':
      return `${p.name}${p.brief ? ` — ${p.brief}` : ''}${p.isError ? ' (error)' : ''}`;
    case 'WORKFLOW_STARTED':
      return `start ${p.workflowId}`;
    case 'WORKFLOW_COMPLETED':
      return `done ${p.workflowId ?? ''}${p.reason ? ` — ${p.reason}` : ''}`;
    case 'AGENT_STEP_STARTED':
      return `agent ${p.agentRef ?? ''}`;
    case 'RUN_PAUSED_RATE_LIMIT':
      return `paused (rate-limit)`;
    case 'CHANGESET_PROMOTED':
      return `promoted ${p.changesetId}`;
    default:
      return JSON.stringify(p).slice(0, 200);
  }
}
