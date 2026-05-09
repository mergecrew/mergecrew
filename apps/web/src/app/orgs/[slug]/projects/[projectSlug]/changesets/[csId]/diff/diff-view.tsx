'use client';

import { useMemo, useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import {
  createCommentAction,
  updateCommentAction,
  deleteCommentAction,
} from './actions';

export interface DiffLine {
  type: 'add' | 'del' | 'context';
  oldLine: number | null;
  newLine: number | null;
  content: string;
}
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface CommentRecord {
  id: string;
  changesetId: string;
  userId: string;
  filePath: string;
  lineRange: { startLine: number; endLine: number } | null;
  body: string;
  parentId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string | null; email: string; avatarUrl: string | null };
}

interface Props {
  slug: string;
  projectSlug: string;
  csId: string;
  files: DiffFile[];
  comments: CommentRecord[];
  currentUserId: string;
}

interface Thread {
  root: CommentRecord;
  replies: CommentRecord[];
}

function buildThreads(comments: CommentRecord[]): Map<string, Thread[]> {
  const byFile = new Map<string, CommentRecord[]>();
  for (const c of comments) {
    if (!byFile.has(c.filePath)) byFile.set(c.filePath, []);
    byFile.get(c.filePath)!.push(c);
  }
  const out = new Map<string, Thread[]>();
  for (const [filePath, items] of byFile) {
    const roots = items.filter((c) => !c.parentId);
    const repliesByParent = new Map<string, CommentRecord[]>();
    for (const c of items) {
      if (c.parentId) {
        if (!repliesByParent.has(c.parentId)) repliesByParent.set(c.parentId, []);
        repliesByParent.get(c.parentId)!.push(c);
      }
    }
    const threads: Thread[] = roots.map((r) => ({
      root: r,
      replies: (repliesByParent.get(r.id) ?? []).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    }));
    threads.sort(
      (a, b) =>
        new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime(),
    );
    out.set(filePath, threads);
  }
  return out;
}

export function DiffView(props: Props) {
  const threads = useMemo(() => buildThreads(props.comments), [props.comments]);

  return (
    <div className="space-y-4">
      {props.files.length === 0 && (
        <p className="text-sm italic text-zinc-500">No file changes returned for this PR.</p>
      )}
      {props.files.map((f) => (
        <FileBlock
          key={f.path}
          file={f}
          threads={threads.get(f.path) ?? []}
          slug={props.slug}
          projectSlug={props.projectSlug}
          csId={props.csId}
          currentUserId={props.currentUserId}
        />
      ))}
    </div>
  );
}

function FileBlock({
  file,
  threads,
  slug,
  projectSlug,
  csId,
  currentUserId,
}: {
  file: DiffFile;
  threads: Thread[];
  slug: string;
  projectSlug: string;
  csId: string;
  currentUserId: string;
}) {
  const threadsByLine = useMemo(() => {
    const m = new Map<number, Thread[]>();
    for (const t of threads) {
      const anchor = t.root.lineRange?.endLine ?? 0;
      if (!m.has(anchor)) m.set(anchor, []);
      m.get(anchor)!.push(t);
    }
    return m;
  }, [threads]);

  const [openLine, setOpenLine] = useState<number | null>(null);

  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-800">
      <details open>
        <summary className="flex cursor-pointer list-none items-baseline justify-between px-3 py-2 text-sm">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-zinc-800 dark:text-zinc-200">{file.path}</span>
            {file.oldPath && file.oldPath !== file.path && (
              <span className="text-xs text-zinc-500">← {file.oldPath}</span>
            )}
            <StatusChip status={file.status} />
          </div>
          <div className="text-xs">
            <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>{' '}
            <span className="text-rose-600 dark:text-rose-400">-{file.deletions}</span>
          </div>
        </summary>

        <div className="border-t border-zinc-200 dark:border-zinc-800">
          {file.hunks.length === 0 ? (
            <p className="p-3 text-xs italic text-zinc-500">
              No textual hunks (binary, rename without content change, or empty patch).
            </p>
          ) : (
            file.hunks.map((h, i) => (
              <HunkBlock
                key={i}
                hunk={h}
                threadsByLine={threadsByLine}
                openLine={openLine}
                setOpenLine={setOpenLine}
                onCreate={(input) =>
                  createCommentAction(slug, projectSlug, csId, {
                    ...input,
                    filePath: file.path,
                  })
                }
                onUpdate={(commentId, patch) =>
                  updateCommentAction(slug, projectSlug, csId, commentId, patch)
                }
                onDelete={(commentId) => deleteCommentAction(slug, projectSlug, csId, commentId)}
                currentUserId={currentUserId}
              />
            ))
          )}
        </div>
      </details>
    </div>
  );
}

function HunkBlock({
  hunk,
  threadsByLine,
  openLine,
  setOpenLine,
  onCreate,
  onUpdate,
  onDelete,
  currentUserId,
}: {
  hunk: DiffHunk;
  threadsByLine: Map<number, Thread[]>;
  openLine: number | null;
  setOpenLine: (l: number | null) => void;
  onCreate: (input: { lineRange?: { startLine: number; endLine: number }; body: string; parentId?: string }) => Promise<any>;
  onUpdate: (commentId: string, patch: { body?: string; resolved?: boolean }) => Promise<any>;
  onDelete: (commentId: string) => Promise<any>;
  currentUserId: string;
}) {
  return (
    <div className="border-t border-zinc-100 first:border-t-0 dark:border-zinc-900">
      <div className="px-3 py-1 font-mono text-[11px] text-zinc-500">
        @@ {hunk.header || `${hunk.oldStart} → ${hunk.newStart}`} @@
      </div>
      <div className="font-mono text-xs">
        {hunk.lines.map((l, i) => {
          const anchorLine = l.newLine ?? l.oldLine ?? 0;
          const threads = threadsByLine.get(anchorLine) ?? [];
          const tone =
            l.type === 'add'
              ? 'bg-emerald-50 dark:bg-emerald-950/40'
              : l.type === 'del'
                ? 'bg-rose-50 dark:bg-rose-950/40'
                : '';
          return (
            <div key={i}>
              <button
                type="button"
                onClick={() =>
                  setOpenLine(openLine === anchorLine ? null : anchorLine)
                }
                className={`flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${tone}`}
                title="Click to comment on this line"
              >
                <span className="w-10 shrink-0 text-right text-zinc-400">{l.oldLine ?? ''}</span>
                <span className="w-10 shrink-0 text-right text-zinc-400">{l.newLine ?? ''}</span>
                <span className="w-3 shrink-0 select-none text-zinc-500">
                  {l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}
                </span>
                <span className="whitespace-pre-wrap break-all text-zinc-800 dark:text-zinc-200">
                  {l.content || ' '}
                </span>
              </button>

              {threads.length > 0 && (
                <div className="space-y-2 border-l-2 border-blue-300 bg-blue-50/40 px-3 py-2 dark:border-blue-800 dark:bg-blue-950/20">
                  {threads.map((t) => (
                    <ThreadView
                      key={t.root.id}
                      thread={t}
                      onReply={(body) =>
                        onCreate({
                          lineRange: { startLine: anchorLine, endLine: anchorLine },
                          body,
                          parentId: t.root.id,
                        })
                      }
                      onUpdate={onUpdate}
                      onDelete={onDelete}
                      currentUserId={currentUserId}
                    />
                  ))}
                </div>
              )}

              {openLine === anchorLine && anchorLine > 0 && (
                <div className="border-l-2 border-amber-300 bg-amber-50/60 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/20">
                  <Composer
                    placeholder={`Comment on line ${anchorLine}`}
                    onCancel={() => setOpenLine(null)}
                    onSubmit={async (body) => {
                      const r = await onCreate({
                        lineRange: { startLine: anchorLine, endLine: anchorLine },
                        body,
                      });
                      if (r.ok) setOpenLine(null);
                      return r;
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ThreadView({
  thread,
  onReply,
  onUpdate,
  onDelete,
  currentUserId,
}: {
  thread: Thread;
  onReply: (body: string) => Promise<any>;
  onUpdate: (commentId: string, patch: { body?: string; resolved?: boolean }) => Promise<any>;
  onDelete: (commentId: string) => Promise<any>;
  currentUserId: string;
}) {
  const [showReply, setShowReply] = useState(false);
  return (
    <div className="space-y-2 rounded bg-white/70 p-2 dark:bg-zinc-900/70">
      <CommentRow
        comment={thread.root}
        onUpdate={onUpdate}
        onDelete={onDelete}
        currentUserId={currentUserId}
      />
      {thread.replies.map((r) => (
        <CommentRow
          key={r.id}
          comment={r}
          onUpdate={onUpdate}
          onDelete={onDelete}
          currentUserId={currentUserId}
          indent
        />
      ))}
      <div className="pl-6">
        {showReply ? (
          <Composer
            placeholder="Reply…"
            onCancel={() => setShowReply(false)}
            onSubmit={async (body) => {
              const r = await onReply(body);
              if (r.ok) setShowReply(false);
              return r;
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowReply(true)}
            className="text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            Reply
          </button>
        )}
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  onUpdate,
  onDelete,
  currentUserId,
  indent,
}: {
  comment: CommentRecord;
  onUpdate: (commentId: string, patch: { body?: string; resolved?: boolean }) => Promise<any>;
  onDelete: (commentId: string) => Promise<any>;
  currentUserId: string;
  indent?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, startTx] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isAuthor = comment.userId === currentUserId;
  const author = comment.user.name ?? comment.user.email;

  const submitEdit = (body: string) =>
    new Promise<any>((resolve) => {
      startTx(async () => {
        const r = await onUpdate(comment.id, { body });
        if (r.ok) setEditing(false);
        else setError(r.error);
        resolve(r);
      });
    });

  return (
    <div className={indent ? 'pl-6' : ''}>
      <div className="flex items-baseline gap-2 text-[11px] text-zinc-500">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{author}</span>
        <span>{new Date(comment.createdAt).toLocaleString()}</span>
        {comment.resolvedAt && (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] uppercase text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
            resolved
          </span>
        )}
      </div>
      {editing ? (
        <Composer
          initial={comment.body}
          placeholder="Edit comment"
          onCancel={() => setEditing(false)}
          onSubmit={submitEdit}
        />
      ) : (
        <p className="whitespace-pre-wrap text-xs text-zinc-800 dark:text-zinc-200">{comment.body}</p>
      )}
      {error && <p className="text-[11px] text-rose-600">{error}</p>}
      {!editing && (
        <div className="mt-1 flex gap-3 text-[11px]">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTx(async () => {
                const r = await onUpdate(comment.id, { resolved: !comment.resolvedAt });
                if (!r.ok) setError(r.error);
              })
            }
            className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            {comment.resolvedAt ? 'Reopen' : 'Resolve'}
          </button>
          {isAuthor && (
            <>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setEditing(true);
                }}
                className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                Edit
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTx(async () => {
                    const r = await onDelete(comment.id);
                    if (!r.ok) setError(r.error);
                  })
                }
                className="text-rose-600 hover:text-rose-800 dark:text-rose-400"
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Composer({
  initial,
  placeholder,
  onCancel,
  onSubmit,
}: {
  initial?: string;
  placeholder: string;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<any>;
}) {
  const [value, setValue] = useState(initial ?? '');
  const [pending, startTx] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (value.trim().length === 0) return;
    setError(null);
    startTx(async () => {
      const r = await onSubmit(value.trim());
      if (r.ok) setValue('');
      else setError(r.error ?? 'failed');
    });
  };

  return (
    <div className="space-y-1">
      <textarea
        className="w-full rounded border px-2 py-1 text-xs dark:bg-zinc-900 dark:border-zinc-700"
        rows={2}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <div className="flex gap-2">
        <Button variant="primary" onClick={submit} disabled={pending || value.trim().length === 0}>
          Post
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        {error && <span className="text-[11px] text-rose-600">{error}</span>}
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: DiffFile['status'] }) {
  const tone =
    status === 'added'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
      : status === 'removed'
        ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
        : status === 'renamed'
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
          : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${tone}`}>{status}</span>
  );
}
