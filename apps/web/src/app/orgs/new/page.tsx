import { PreOrgNav } from '@/components/pre-org-nav';
import { CreateOrgForm } from '@/components/create-org-form';
import { createOrgAction } from './actions';

export const dynamic = 'force-dynamic';

export default function NewOrgPage() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <PreOrgNav />
      <main className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-[32px] font-medium tracking-[-0.025em]">Create an organization</h1>
        <p className="mt-2 text-[13.5px] text-ink-2">
          Each org is isolated — its own projects, LLM keys, budgets, and Postgres RLS scope.
        </p>
        <div className="mt-8 border border-hair bg-paper p-6 shadow-card">
          <CreateOrgForm action={createOrgAction} />
        </div>
      </main>
    </div>
  );
}
