import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';

/**
 * Envelope encryption (dev-grade): a single master key in env (`KMS_MASTER_KEY`)
 * encrypts a per-row data key with AES-256-GCM. In prod this would call AWS KMS
 * Encrypt/Decrypt with a CMK. The shape and call sites stay identical.
 */
@Injectable()
export class CryptoService {
  private masterKey: Buffer;

  constructor() {
    const v = process.env.KMS_MASTER_KEY ?? 'base64:0000000000000000000000000000000000000000000=';
    if (!v.startsWith('base64:')) throw new Error('KMS_MASTER_KEY must start with base64:');
    const buf = Buffer.from(v.slice(7), 'base64');
    if (buf.length !== 32) throw new Error('KMS_MASTER_KEY must be 32 bytes');
    this.masterKey = buf;
  }

  encrypt(plaintext: string): Buffer {
    const dataKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const wrapIv = crypto.randomBytes(12);
    const wrapCipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, wrapIv);
    const wrapped = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
    const wrapTag = wrapCipher.getAuthTag();

    // Layout: [1B version][12B wrapIv][16B wrapTag][32B wrapped][12B iv][16B tag][N ct]
    return Buffer.concat([Buffer.from([1]), wrapIv, wrapTag, wrapped, iv, tag, ct]);
  }

  decrypt(blob: Buffer): string {
    if (blob[0] !== 1) throw new Error('unknown ciphertext version');
    let pos = 1;
    const wrapIv = blob.subarray(pos, pos + 12); pos += 12;
    const wrapTag = blob.subarray(pos, pos + 16); pos += 16;
    const wrapped = blob.subarray(pos, pos + 32); pos += 32;
    const iv = blob.subarray(pos, pos + 12); pos += 12;
    const tag = blob.subarray(pos, pos + 16); pos += 16;
    const ct = blob.subarray(pos);

    const wrapDecipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, wrapIv);
    wrapDecipher.setAuthTag(wrapTag);
    const dataKey = Buffer.concat([wrapDecipher.update(wrapped), wrapDecipher.final()]);

    const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }
}
