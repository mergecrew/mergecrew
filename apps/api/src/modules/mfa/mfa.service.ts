import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { ValidationError } from '@mergecrew/domain';
import { PrismaService } from '../../common/prisma.service.js';
import { TenantContextService } from '../../common/tenant-context.service.js';
import { CryptoService } from '../../common/crypto.service.js';

const ISSUER = 'Mergecrew';

@Injectable()
export class MfaService {
  constructor(
    private prisma: PrismaService,
    private tenant: TenantContextService,
    private crypto: CryptoService,
  ) {}

  async status() {
    const u = await this.requireUser();
    return {
      enrolled: u.mfaEnrolledAt !== null,
      enrolledAt: u.mfaEnrolledAt,
      pending: u.mfaPendingCiphertext !== null,
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
   * to `mfa_secret_ciphertext`, clear the pending column, set enrolledAt.
   */
  async verify(input: { code: string }): Promise<void> {
    const u = await this.requireUser();
    if (!u.mfaPendingCiphertext) {
      throw new ValidationError('no pending MFA setup; call /mfa/setup first');
    }
    const secret = this.crypto.decrypt(u.mfaPendingCiphertext);
    if (!authenticator.check(input.code, secret)) {
      throw new ValidationError('invalid TOTP code');
    }
    await this.prisma.withSystem((tx) =>
      tx.user.update({
        where: { id: u.id },
        data: {
          mfaSecretCiphertext: u.mfaPendingCiphertext,
          mfaPendingCiphertext: null,
          mfaEnrolledAt: new Date(),
        },
      }),
    );
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
    await this.prisma.withSystem((tx) =>
      tx.user.update({
        where: { id: u.id },
        data: {
          mfaSecretCiphertext: null,
          mfaPendingCiphertext: null,
          mfaEnrolledAt: null,
        },
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
