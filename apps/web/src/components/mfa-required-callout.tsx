import { LinkButton } from '@/components/ui';

/**
 * Shown on admin-only pages when the caller is admin/owner but hasn't
 * enrolled in MFA yet. Without this guard, the underlying admin GET
 * fails the RoleGuard's MFA gate (#107) and the page crashes — see
 * the page-level try/catch around api(...) calls.
 */
export function MfaRequiredCallout() {
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-900/20">
      <div className="font-medium text-amber-900 dark:text-amber-200">
        MFA enrollment required
      </div>
      <p className="mt-1 text-amber-800 dark:text-amber-300">
        Admin and owner write actions on this org need two-factor authentication.
        Set it up first, then come back here.
      </p>
      <div className="mt-3">
        <LinkButton href="/account/security" variant="primary">
          Set up MFA →
        </LinkButton>
      </div>
    </div>
  );
}

/**
 * Returns true if the thrown error from `api(...)` indicates the
 * RoleGuard's "you need MFA" responses (codes minted in role.guard.ts:
 * `MFA_REQUIRED_NOT_ENROLLED` for unenrolled admins, `MFA_CHALLENGE_REQUIRED`
 * when the JWT's mfa_at claim is stale).
 */
export function isMfaGateError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /MFA_(REQUIRED_NOT_ENROLLED|CHALLENGE_REQUIRED)/.test(msg);
}
