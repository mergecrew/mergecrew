import { LinkButton } from '@/components/ui';

/**
 * Passive nudge shown on admin/owner pages when the caller hasn't
 * enrolled in MFA. The API doesn't enforce MFA on writes (see
 * `apps/api/src/common/role.guard.ts`) — this is a recommendation, not
 * a gate. Renders inline; the page below it works whether the user
 * follows the link or ignores it.
 *
 * The component is named `MfaRequiredCallout` for backwards-compat with
 * existing imports; the copy is "recommended" because that's what the
 * policy actually is now.
 */
export function MfaRequiredCallout() {
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-900/20">
      <div className="font-medium text-amber-900 dark:text-amber-200">
        Two-factor authentication recommended
      </div>
      <p className="mt-1 text-amber-800 dark:text-amber-300">
        Admin and owner accounts can create API keys, manage members, and
        access audit logs. Enabling MFA hardens those accounts against
        password-only compromise. Optional, but recommended.
      </p>
      <div className="mt-3">
        <LinkButton href="/account/security" variant="primary">
          Set up MFA →
        </LinkButton>
      </div>
    </div>
  );
}
