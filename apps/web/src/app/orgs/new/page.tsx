import { PreOrgNav } from '@/components/pre-org-nav';
import { CreateOrgForm } from '@/components/create-org-form';
import { createOrgAction } from './actions';

export const dynamic = 'force-dynamic';

export default function NewOrgPage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <PreOrgNav />
      <main className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">Create an organization</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Each org is isolated — its own projects, LLM keys, budgets, and Postgres RLS scope.
        </p>
        <div className="mt-8 rounded-lg border bg-[rgb(var(--card))] p-6 shadow-sm">
          <CreateOrgForm action={createOrgAction} />
        </div>
      </main>
    </div>
  );
}
