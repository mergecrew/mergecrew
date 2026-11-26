import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { authenticator } from 'otplib';
import { ValidationError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { CryptoService } from '../../common/crypto.service.js';
import { AuthService } from '../auth/auth.service.js';

const ISSUER = 'Mergecrew';
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 6; // 12 hex chars per code

/** Consecutive wrong codes before the account's MFA checks are locked. */
export const MFA_MAX_FAILED_ATTEMPTS = 10;
/** How long a lockout lasts. */
export const MFA_LOCKOUT_MS = 15 * 60 * 1000;

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    codes.push(crypto.randomBytes(RECOVERY_CODE_BYTES).toString('hex'));
  }
  return codes;
}

/** Current TOTP time-step plus the matched offset, or null when the code is wrong. */
function matchedTotpStep(code: string, secret: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = authenticator.checkDelta(code, secret);
  if (delta === null) return null;
  const stepSeconds = authenticator.allOptions().step ?? 30;
  return Math.floor(nowMs / 1000 / stepSeconds) + delta;
}

type CodeKind = 'totp' | 'recovery';

interface MfaUserRow {
  id: string;
  mfaSecretCiphertext: Uint8Array | null;
  mfaLockedUntil: Date | null;
  mfaFailedAttempts: number;
}

@Injectable()
export class MfaService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private crypto: CryptoService,
    private auth: AuthService,
  ) {}

  async status() {
    const u = await this.requireUser();
    const recoveryRemaining = u.mfaEnrolledAt
      ? await this.prisma.withSystem((tx) =>
          tx.userMfaRecoveryCode.count({ where: { userId: u.id } }),
        )
      : 0;
    return {
      enrolled: u.mfaEnrolledAt !== null,
      enrolledAt: u.mfaEnrolledAt,
      pending: u.mfaPendingCiphertext !== null,
      recoveryCodesRemaining: recoveryRemaining,
    };
  }

  /**
   * Begin enrollment: produce a fresh TOTP secret + matching otpauth URL,
   * persist the (still-unconfirmed) secret in `mfa_pending_ciphertext`.
   *
   * Idempotent: if a pending secret already exists, we reuse it and return
   * the same otpauth URL. This lets the setup page recover the QR code
   * after a refresh without rotating the secret behind the user's back —
   * if the user has already scanned the previous QR into their app, they
   * can keep using it. Pass `force: true` to discard and rotate.
   *
   * Re-enrolment: when the user already has a confirmed secret, starting a
   * new setup (forced or not) requires `code` — a current TOTP or an unused
   * recovery code — so a stolen session cannot swap the authenticator.
   */
  async setup(
    opts: { force?: boolean; code?: string } = {},
  ): Promise<{ otpauthUrl: string; secret: string }> {
    const u = await this.requireUser();
    const enrolled = u.mfaSecretCiphertext !== null && u.mfaEnrolledAt !== null;
    if (enrolled) {
      if (!opts.code?.trim()) {
        throw new ValidationError(
          'MFA is already enrolled; enter a current code (or a recovery code) to re-enrol',
        );
      }
      await this.verifyEnrolledCode(u, opts.code, { allowRecovery: true });
    }
    let secret: string;
    if (u.mfaPendingCiphertext && !opts.force) {
      secret = this.crypto.decrypt(u.mfaPendingCiphertext);
    } else {
      secret = authenticator.generateSecret();
      const ciphertext = this.crypto.encrypt(secret);
      await this.prisma.withSystem((tx) =>
        tx.user.update({
          where: { id: u.id },
          data: { mfaPendingCiphertext: ciphertext },
        }),
      );
    }
    const otpauthUrl = authenticator.keyuri(u.email, ISSUER, secret);
    return { otpauthUrl, secret };
  }

  /**
   * Confirm a pending secret with a fresh TOTP code. On success, promote it
   * to `mfa_secret_ciphertext`, clear the pending column, set enrolledAt,
   * and issue 10 single-use recovery codes (returned cleartext, hashed at
   * rest). Also issues a fresh session JWT with `mfa_at` set so the user
   * can immediately use admin routes without a follow-up /mfa/challenge
   * round-trip.
   */
  async verify(input: { code: string }): Promise<{ recoveryCodes: string[]; token: string }> {
    const u = await this.requireUser();
    if (!u.mfaPendingCiphertext) {
      throw new ValidationError('no pending MFA setup; call /mfa/setup first');
    }
    this.assertNotLocked(u);
    const secret = this.crypto.decrypt(u.mfaPendingCiphertext);
    if (!(await this.acceptTotp(u.id, String(input?.code ?? '').trim(), secret))) {
      await this.recordFailure(u.id);
      throw new ValidationError('invalid TOTP code');
    }
    await this.recordSuccess(u);

    const codes = generateRecoveryCodes();
    await this.prisma.withSystem(async (tx) => {
      await tx.user.update({
        where: { id: u.id },
        data: {
          mfaSecretCiphertext: u.mfaPendingCiphertext,
          mfaPendingCiphertext: null,
          mfaEnrolledAt: new Date(),
        },
      });
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId: u.id } });
      await tx.userMfaRecoveryCode.createMany({
        data: codes.map((c) => ({ userId: u.id, codeHash: hashCode(c) })),
      });
    });
    const token = this.auth.signSessionJwt(u.id, { tokenVersion: u.tokenVersion, mfaAt: new Date() });
    return { recoveryCodes: codes, token };
  }

  /**
   * Consume a TOTP code OR a single-use recovery code. Used by the login
   * challenge flow (#107) and any /mfa-required action. Returns the kind
   * of credential that succeeded so the caller can warn when recovery
   * codes run low.
   *
   * TOTP codes are single-use (the accepted time-step is recorded), and
   * repeated failures lock MFA checks for the account for a while.
   */
  async consume(userId: string, code: string): Promise<{ kind: CodeKind; remaining?: number }> {
    const u = await this.prisma.withSystem((tx) => tx.user.findUnique({ where: { id: userId } }));
    if (!u || !u.mfaSecretCiphertext) throw new ValidationError('MFA not enrolled');
    const kind = await this.verifyEnrolledCode(u, code, { allowRecovery: true });
    if (kind === 'recovery') {
      const remaining = await this.prisma.withSystem((tx) =>
        tx.userMfaRecoveryCode.count({ where: { userId } }),
      );
      return { kind, remaining };
    }
    return { kind };
  }

  /**
   * Pass a TOTP/recovery challenge for the *current* user and receive a
   * fresh session JWT that carries an `mfa_at` claim. This is also how an
   * MFA-enrolled user finishes signing in: the pre-MFA token issued by
   * magic-link verify / OAuth exchange is accepted on this route only.
   * Admin/owner write routes require the claim to be ≤ 15 min old.
   *
   * Returns the new token plus what kind of credential was consumed and
   * remaining recovery-code count, so the frontend can show a low-codes
   * warning when the user is about to run out.
   */
  async challenge(input: { code: string }): Promise<{
    token: string;
    kind: CodeKind;
    recoveryCodesRemaining?: number;
    user: { id: string; email: string; name: string | null };
  }> {
    const userId = this.tenant.requireUser().userId;
    const result = await this.consume(userId, String(input?.code ?? ''));
    const u = await this.prisma.withSystem((tx) => tx.user.findUnique({ where: { id: userId } }));
    if (!u) throw new ValidationError('user not found');
    const token = this.auth.signSessionJwt(userId, { tokenVersion: u.tokenVersion, mfaAt: new Date() });
    return {
      token,
      kind: result.kind,
      ...(result.kind === 'recovery' ? { recoveryCodesRemaining: result.remaining } : {}),
      user: { id: u.id, email: u.email, name: u.name },
    };
  }

  /**
   * Regenerate the recovery-codes set. Requires a fresh TOTP from the
   * confirmed secret to prevent a stolen session from quietly burning the
   * old codes.
   */
  async regenerateRecoveryCodes(input: { code: string }): Promise<{ recoveryCodes: string[] }> {
    const u = await this.requireUser();
    if (!u.mfaSecretCiphertext) throw new ValidationError('MFA is not enrolled');
    await this.verifyEnrolledCode(u, String(input?.code ?? ''), { allowRecovery: false });
    const codes = generateRecoveryCodes();
    await this.prisma.withSystem(async (tx) => {
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId: u.id } });
      await tx.userMfaRecoveryCode.createMany({
        data: codes.map((c) => ({ userId: u.id, codeHash: hashCode(c) })),
      });
    });
    return { recoveryCodes: codes };
  }

  /**
   * Disable MFA for the current user. Requires a valid TOTP from the existing
   * confirmed secret to prevent a stolen session from disabling MFA silently.
   */
  async disable(input: { code: string }): Promise<void> {
    const u = await this.requireUser();
    if (!u.mfaSecretCiphertext) {
      throw new ValidationError('MFA is not enrolled');
    }
    await this.verifyEnrolledCode(u, String(input?.code ?? ''), { allowRecovery: false });
    await this.prisma.withSystem(async (tx) => {
      await tx.user.update({
        where: { id: u.id },
        data: {
          mfaSecretCiphertext: null,
          mfaPendingCiphertext: null,
          mfaEnrolledAt: null,
        },
      });
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId: u.id } });
    });
  }

  /**
   * Check a code against the user's confirmed secret (and optionally the
   * recovery-code set), applying lockout and TOTP replay protection.
   * Throws on failure; returns which credential matched on success.
   */
  private async verifyEnrolledCode(
    u: MfaUserRow,
    rawCode: string,
    opts: { allowRecovery: boolean },
  ): Promise<CodeKind> {
    if (!u.mfaSecretCiphertext) throw new ValidationError('MFA is not enrolled');
    this.assertNotLocked(u);
    const code = String(rawCode ?? '').trim();

    const secret = this.crypto.decrypt(u.mfaSecretCiphertext);
    if (await this.acceptTotp(u.id, code, secret)) {
      await this.recordSuccess(u);
      return 'totp';
    }

    if (opts.allowRecovery && code.length > 0 && !/^\d{6}$/.test(code)) {
      const consumed = await this.prisma.withSystem((tx) =>
        tx.userMfaRecoveryCode.deleteMany({ where: { userId: u.id, codeHash: hashCode(code) } }),
      );
      if (consumed.count > 0) {
        await this.recordSuccess(u);
        return 'recovery';
      }
    }

    await this.recordFailure(u.id);
    throw new ValidationError(opts.allowRecovery ? 'invalid TOTP or recovery code' : 'invalid TOTP code');
  }

  /**
   * Accept a TOTP code at most once: the matched time-step must be newer
   * than the last accepted one. The conditional update makes concurrent
   * submissions of the same code race-safe (only one wins).
   */
  private async acceptTotp(userId: string, code: string, secret: string): Promise<boolean> {
    const step = matchedTotpStep(code, secret);
    if (step === null) return false;
    const res = await this.prisma.withSystem((tx) =>
      tx.user.updateMany({
        where: {
          id: userId,
          OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }],
        },
        data: { mfaLastUsedStep: step },
      }),
    );
    return res.count === 1;
  }

  private assertNotLocked(u: { mfaLockedUntil: Date | null }): void {
    if (u.mfaLockedUntil && u.mfaLockedUntil.getTime() > Date.now()) {
      throw new HttpException(
        {
          code: 'MFA_LOCKED',
          message: 'Too many incorrect codes. Try again later.',
          retryAfterSeconds: Math.ceil((u.mfaLockedUntil.getTime() - Date.now()) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async recordFailure(userId: string): Promise<void> {
    const updated = await this.prisma.withSystem((tx) =>
      tx.user.update({
        where: { id: userId },
        data: { mfaFailedAttempts: { increment: 1 } },
        select: { mfaFailedAttempts: true },
      }),
    );
    if (updated.mfaFailedAttempts >= MFA_MAX_FAILED_ATTEMPTS) {
      await this.prisma.withSystem((tx) =>
        tx.user.update({
          where: { id: userId },
          data: { mfaFailedAttempts: 0, mfaLockedUntil: new Date(Date.now() + MFA_LOCKOUT_MS) },
        }),
      );
    }
  }

  private async recordSuccess(u: { id: string; mfaFailedAttempts: number; mfaLockedUntil: Date | null }) {
    if (u.mfaFailedAttempts === 0 && u.mfaLockedUntil === null) return;
    await this.prisma.withSystem((tx) =>
      tx.user.update({
        where: { id: u.id },
        data: { mfaFailedAttempts: 0, mfaLockedUntil: null },
      }),
    );
  }

  private async requireUser() {
    const userId = this.tenant.requireUser().userId;
    const u = await this.prisma.withSystem((tx) =>
      tx.user.findUnique({ where: { id: userId } }),
    );
    if (!u) throw new ValidationError('user not found');
    return u;
  }
}
