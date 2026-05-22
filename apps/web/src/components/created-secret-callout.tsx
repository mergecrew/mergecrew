'use client';

import { useState } from 'react';

/**
 * One-time-display callout for a freshly minted secret (webhook signing
 * secret, API key token). The value is shown verbatim with a copy button —
 * after this render the only way to recover it is to rotate the row.
 */
export function CreatedSecretCallout({ secret, label }: { secret: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="border border-warn bg-warn/20 p-3 text-sm">
      <div className="font-medium text-ink">{label}</div>
      <p className="mt-1 text-ink">
        Copy it now — it will not be shown again. If you lose it, delete this webhook and create a
        new one.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs ">
          {secret}
        </code>
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs hover:bg-bg-2"
          onClick={async () => {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
