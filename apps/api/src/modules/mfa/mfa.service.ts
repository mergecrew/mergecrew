import { Injectable } from '@nestjs/common';
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
   * Calling this overwrites any prior pending secret.
   */
  async setup(): Promise<{ otpauthUrl: string; secret: string }> {
    const u = await this.requireUser();
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(u.email, ISSUER, secret);
    const ciphertext = this.crypto.encrypt(secret);
    await this.prisma.withSystem((tx) =>
      tx.user.update({
        where: { id: u.id },
        data: { mfaPendingCiphertext: ciphertext },
      }),
    );
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
    const secret = this.crypto.decrypt(u.mfaPendingCiphertext);
    if (!authenticator.check(input.code, secret)) {
      throw new ValidationError('invalid TOTP code');
    }

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
    const token = this.auth.signSessionJwt(u.id, { mfaAt: new Date() });
    return { recoveryCodes: codes, token };
  }

  /**
   * Consume a TOTP code OR a single-use recovery code. Used by the login
   * challenge flow (#107) and any /mfa-required action. Returns the kind
   * of credential that succeeded so the caller can warn when recovery
   * codes run low.
   */
  async consume(userId: string, code: string): Promise<{ kind: 'totp' | 'recovery'; remaining?: number }> {
    const trimmed = code.trim();
    const u = await this.prisma.withSystem((tx) => tx.user.findUnique({ where: { id: userId } }));
    if (!u || !u.mfaSecretCiphertext) throw new ValidationError('MFA not enrolled');

    // Path 1: TOTP.
    if (/^\d{6}$/.test(trimmed)) {
      const secret = this.crypto.decrypt(u.mfaSecretCiphertext);
      if (authenticator.check(trimmed, secret)) return { kind: 'totp' };
    }

    // Path 2: recovery code.
    const hash = hashCode(trimmed);
    const consumed = await this.prisma.withSystem((tx) =>
      tx.userMfaRecoveryCode.deleteMany({ where: { userId, codeHash: hash } }),
    );
    if (consumed.count > 0) {
      const remaining = await this.prisma.withSystem((tx) =>
        tx.userMfaRecoveryCode.count({ where: { userId } }),
      );
      return { kind: 'recovery', remaining };
    }
    throw new ValidationError('invalid TOTP or recovery code');
  }

  /**
   * Pass a TOTP/recovery challenge for the *current* user and receive a
   * fresh session JWT that carries an `mfa_at` claim. Admin/owner routes
   * (#107) require this claim to be ≤ 15 min old.
   *
   * Returns the new token plus what kind of credential was consumed and
   * remaining recovery-code count, so the frontend can show a low-codes
   * warning when the user is about to run out.
   */
  async challenge(input: { code: string }): Promise<{
    token: string;
    kind: 'totp' | 'recovery';
    recoveryCodesRemaining?: number;
  }> {
    const userId = this.tenant.requireUser().userId;
    const result = await this.consume(userId, input.code);
    const token = this.auth.signSessionJwt(userId, { mfaAt: new Date() });
    return {
      token,
      kind: result.kind,
      ...(result.kind === 'recovery' ? { recoveryCodesRemaining: result.remaining } : {}),
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
    const secret = this.crypto.decrypt(u.mfaSecretCiphertext);
    if (!authenticator.check(input.code, secret)) {
      throw new ValidationError('invalid TOTP code');
    }
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
    const secret = this.crypto.decrypt(u.mfaSecretCiphertext);
    if (!authenticator.check(input.code, secret)) {
      throw new ValidationError('invalid TOTP code');
    }
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

  private async requireUser() {
    const userId = this.tenant.requireUser().userId;
    const u = await this.prisma.withSystem((tx) =>
      tx.user.findUnique({ where: { id: userId } }),
    );
    if (!u) throw new ValidationError('user not found');
    return u;
  }
}
