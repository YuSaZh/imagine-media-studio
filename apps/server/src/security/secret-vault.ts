import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { z } from 'zod';

const EnvelopeSchema = z.object({
  v: z.literal(1),
  salt: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ciphertext: z.string(),
}).strict();

type Envelope = z.infer<typeof EnvelopeSchema>;

export class SecretVaultError extends Error {
  public override readonly name = 'SecretVaultError';
}

export class SecretVault {
  public constructor(private readonly applicationSecret: string) {
    if (applicationSecret.length < 16) {
      throw new SecretVaultError('The application secret is too short.');
    }
  }

  public encryptString(providerId: string, field: string, plaintext: string): string {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = this.deriveKey(salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(this.aad(providerId, field));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const envelope: Envelope = {
      v: 1,
      salt: salt.toString('base64url'),
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
    return JSON.stringify(envelope);
  }

  public decryptString(providerId: string, field: string, serializedEnvelope: string): string {
    try {
      const envelope = EnvelopeSchema.parse(JSON.parse(serializedEnvelope));
      const salt = Buffer.from(envelope.salt, 'base64url');
      const iv = Buffer.from(envelope.iv, 'base64url');
      const tag = Buffer.from(envelope.tag, 'base64url');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
      if (salt.byteLength !== 16 || iv.byteLength !== 12 || tag.byteLength !== 16) {
        throw new Error('Invalid encrypted envelope dimensions.');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.deriveKey(salt), iv);
      decipher.setAAD(this.aad(providerId, field));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretVaultError('Unable to decrypt the Provider secret.');
    }
  }

  public encryptJson(
    providerId: string,
    field: string,
    value: Readonly<Record<string, string>>,
  ): string {
    return this.encryptString(providerId, field, JSON.stringify(value));
  }

  public decryptJson(
    providerId: string,
    field: string,
    serializedEnvelope: string,
  ): Readonly<Record<string, string>> {
    try {
      return z.record(z.string(), z.string()).parse(
        JSON.parse(this.decryptString(providerId, field, serializedEnvelope)),
      );
    } catch (error) {
      if (error instanceof SecretVaultError) throw error;
      throw new SecretVaultError('Unable to decrypt the Provider secret.');
    }
  }

  private aad(providerId: string, field: string): Buffer {
    return Buffer.from(`imagine-media-studio/provider/${providerId}/${field}/v1`, 'utf8');
  }

  private deriveKey(salt: Buffer): Buffer {
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(this.applicationSecret, 'utf8'),
        salt,
        Buffer.from('imagine-media-studio/provider-secrets/v1', 'utf8'),
        32,
      ),
    );
  }
}
