import { describe, expect, it } from 'vitest';

import { SecretVault, SecretVaultError } from './secret-vault.js';

describe('SecretVault', () => {
  it('round-trips strings and header maps with randomized envelopes', () => {
    const vault = new SecretVault('test-secret-with-enough-entropy-for-round-trip');
    const first = vault.encryptString('provider-1', 'apiKey', 'secret-value');
    const second = vault.encryptString('provider-1', 'apiKey', 'secret-value');

    expect(first).not.toBe(second);
    expect(vault.decryptString('provider-1', 'apiKey', first)).toBe('secret-value');
    const headers = vault.encryptJson('provider-1', 'headers', { 'X-Signature': 'value' });
    expect(vault.decryptJson('provider-1', 'headers', headers)).toEqual({
      'X-Signature': 'value',
    });
  });

  it('binds ciphertext to the Provider, field, and application secret', () => {
    const vault = new SecretVault('test-secret-with-enough-entropy-for-aad-binding');
    const encrypted = vault.encryptString('provider-1', 'apiKey', 'secret-value');

    expect(() => vault.decryptString('provider-2', 'apiKey', encrypted)).toThrow(
      SecretVaultError,
    );
    expect(() => vault.decryptString('provider-1', 'headers', encrypted)).toThrow(
      SecretVaultError,
    );
    expect(() =>
      new SecretVault('different-test-secret-with-enough-entropy').decryptString(
        'provider-1',
        'apiKey',
        encrypted,
      ),
    ).toThrow(SecretVaultError);
  });

  it('rejects malformed and tampered envelopes without echoing secret material', () => {
    const vault = new SecretVault('test-secret-with-enough-entropy-for-tamper-check');
    const encrypted = vault.encryptString('provider-1', 'apiKey', 'secret-value');
    const envelope = JSON.parse(encrypted) as Record<string, unknown>;
    const ciphertext = String(envelope.ciphertext);
    envelope.ciphertext = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;

    expect(() => vault.decryptString('provider-1', 'apiKey', JSON.stringify(envelope))).toThrow(
      'Unable to decrypt the Provider secret.',
    );
    expect(() => vault.decryptString('provider-1', 'apiKey', 'not-json')).toThrow(
      'Unable to decrypt the Provider secret.',
    );
  });
});
