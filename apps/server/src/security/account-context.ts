import { AsyncLocalStorage } from 'node:async_hooks';

export interface AccountIdentity { id: string; username: string; role: 'admin' | 'user'; }
export const accountContext = new AsyncLocalStorage<AccountIdentity>();
export function requestOwner(): string {
  const account = accountContext.getStore();
  if (!account) throw new Error('Authenticated account context is missing.');
  return account.id;
}
