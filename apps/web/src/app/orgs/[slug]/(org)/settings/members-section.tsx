'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, RolePill } from '@/components/ui';

type Role = 'owner' | 'admin' | 'operator' | 'viewer';
// RolePill's union accepts a wider set (reviewer / member / pending);
// our concrete API roles are a subset.

type Member = {
  id: string;
  role: Role;
  user: { id: string; email: string; name?: string | null };
};

type ServerActions = {
  invite: (input: { email: string; role: 'admin' | 'operator' | 'viewer' }) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  updateRole: (id: string, role: Role) => Promise<{ ok: true } | { ok: false; error: string }>;
  remove: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export function MembersSection({
  members,
  canEdit,
  currentUserId,
  actions,
}: {
  members: Member[];
  canEdit: boolean;
  currentUserId: string | null;
  actions: ServerActions;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const invite = (formData: FormData) => {
    setError(null);
    const email = String(formData.get('email') ?? '').trim();
    const role = String(formData.get('role') ?? 'viewer') as 'admin' | 'operator' | 'viewer';
    if (!email) {
      setError('Email is required.');
      return;
    }
    startTransition(async () => {
      const r = await actions.invite({ email, role });
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };

  const changeRole = (id: string, role: Role) => {
    setError(null);
    startTransition(async () => {
      const r = await actions.updateRole(id, role);
      if (!r.ok) setError(r.error);
      else {
        setEditing(null);
        router.refresh();
      }
    });
  };

  const remove = (m: Member) => {
    setError(null);
    if (!window.confirm(`Remove ${m.user.email} from this org?`)) return;
    startTransition(async () => {
      const r = await actions.remove(m.id);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {canEdit && (
        <form
          action={invite}
          className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px_auto]"
        >
          <Input
            name="email"
            type="email"
            placeholder="someone@example.com"
            required
            mono
          />
          <select
            name="role"
            defaultValue="viewer"
            className="h-[36px] border border-hair bg-paper-2 px-3 text-[13.5px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          >
            <option value="viewer">viewer</option>
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
          <Button variant="accent" size="sm" type="submit" disabled={pending}>
            Invite
          </Button>
        </form>
      )}

      {error && (
        <div className="border border-energy bg-energy-soft p-3 text-[12.5px] text-energy-deep">
          {error}
        </div>
      )}

      {members.length === 0 ? (
        <div className="border border-hair bg-paper p-5 text-[13px] text-muted">
          No members yet.
        </div>
      ) : (
        <div className="border border-hair bg-paper">
          <ul className="m-0 list-none p-0">
            {members.map((m, i) => {
              const isSelf = currentUserId === m.user.id;
              return (
                <li
                  key={m.id}
                  className={i < members.length - 1 ? 'border-b border-hair-2' : ''}
                >
                  <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium tracking-[-0.005em]">
                        {m.user.name ?? m.user.email}
                        {isSelf && (
                          <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
                            you
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[11.5px] text-muted">{m.user.email}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {editing === m.id && canEdit ? (
                        <RoleSelect
                          value={m.role}
                          disabled={pending}
                          onChange={(v) => changeRole(m.id, v)}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <RolePill role={m.role} />
                      )}
                      {canEdit && editing !== m.id && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => setEditing(m.id)}
                        >
                          Edit
                        </Button>
                      )}
                      {canEdit && (
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={pending}
                          onClick={() => remove(m)}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function RoleSelect({
  value,
  disabled,
  onChange,
  onCancel,
}: {
  value: Role;
  disabled: boolean;
  onChange: (v: Role) => void;
  onCancel: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <select
        defaultValue={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as Role)}
        className="h-[28px] border border-hair bg-paper-2 px-2 text-[12.5px] text-ink outline-none focus:border-accent"
      >
        <option value="owner">owner</option>
        <option value="admin">admin</option>
        <option value="operator">operator</option>
        <option value="viewer">viewer</option>
      </select>
      <button
        type="button"
        onClick={onCancel}
        className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted hover:text-ink"
      >
        cancel
      </button>
    </span>
  );
}
