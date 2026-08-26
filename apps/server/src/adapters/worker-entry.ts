import { parentPort, workerData } from 'node:worker_threads';

import {
  assertBoundedAdapterData,
  MAX_ERROR_REDACTION_INPUT_BYTES,
  messageBytes,
  type AdapterHttpRequest,
  type AdapterHttpResultMessage,
  type AdapterWorkerData,
} from './worker-protocol.js';

if (parentPort === null) throw new Error('Adapter worker requires a parent port.');

const data = workerData as AdapterWorkerData;
const MAX_WORKER_MESSAGE_BYTES = 16 * 1024 * 1024;
const pendingHttp = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let httpSequence = 0;

function disableDirectNetworkGlobals(): void {
  const globals = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'] as const;
  for (const name of globals) {
    try {
      Object.defineProperty(globalThis, name, { configurable: false, value: undefined, writable: false });
    } catch {
      // The preflight remains the primary best-effort policy for non-configurable globals.
    }
  }
  try {
    const navigatorValue = (globalThis as unknown as Record<string, unknown>).navigator;
    if (navigatorValue !== null && typeof navigatorValue === 'object') {
      Object.defineProperty(navigatorValue, 'sendBeacon', { configurable: false, value: undefined, writable: false });
    }
  } catch {
    // Node normally has no navigator; this is only a defense-in-depth hook.
  }
}

disableDirectNetworkGlobals();

function boundedError(error: unknown): { name: string; message: string; code?: string; status?: number } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: error instanceof Error ? error.name.slice(0, 128) : 'Error',
    message: message.slice(0, MAX_ERROR_REDACTION_INPUT_BYTES),
    ...(error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? { code: error.code.slice(0, 128) }
      : {}),
    ...(error !== null && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? { status: error.status }
      : {}),
  };
}

function post(value: unknown): boolean {
  if (messageBytes(value) > MAX_WORKER_MESSAGE_BYTES) throw new Error('Adapter worker message is too large.');
  try {
    parentPort?.postMessage(value);
    return true;
  } catch {
    return false;
  }
}

function httpRequest(input: AdapterHttpRequest): Promise<unknown> {
  const requestId = `${data.requestId}:http:${httpSequence++}`;
  return new Promise((resolve, reject) => {
    pendingHttp.set(requestId, { resolve, reject });
    try {
      if (!post({ kind: 'http-request', requestId, input })) {
        pendingHttp.delete(requestId);
        reject(new Error('Adapter worker host closed.'));
      }
    } catch (error) {
      pendingHttp.delete(requestId);
      reject(error);
    }
  });
}

parentPort.on('message', (message: AdapterHttpResultMessage) => {
  if (message === null || typeof message !== 'object' || message.kind !== 'http-result' || typeof message.requestId !== 'string') return;
  const pending = pendingHttp.get(message.requestId);
  if (pending === undefined) return;
  pendingHttp.delete(message.requestId);
  if (message.ok) pending.resolve(message.value);
  else pending.reject(new Error(message.error?.message ?? 'Safe HTTP request failed.'));
});

parentPort.on('close', () => {
  for (const pending of pendingHttp.values()) pending.reject(new Error('Adapter worker host closed.'));
  pendingHttp.clear();
});

async function loadAdapter(): Promise<Record<string, unknown>> {
  const encoded = Buffer.from(data.source, 'utf8').toString('base64');
  const moduleUrl = `data:text/javascript;base64,${encoded}`;
  return (await import(moduleUrl)) as Record<string, unknown>;
}

async function invoke(): Promise<unknown> {
  const adapter = await loadAdapter();
  const provider = data.provider;
  const http = { request: httpRequest };
  if (data.call === 'capabilities') {
    const value = adapter.capabilities;
    return typeof value === 'function' ? await (value as () => unknown)() : value;
  }
  if (data.call === 'submit') {
    const fn = adapter.submit;
    if (typeof fn !== 'function') throw new Error('Adapter does not export submit.');
    return await (fn as (input: unknown) => unknown)({ request: data.request, provider, http, files: data.files ?? [] });
  }
  if (data.call === 'poll') {
    const fn = adapter.poll;
    if (typeof fn !== 'function') throw new Error('Adapter does not export poll.');
    return await (fn as (input: unknown) => unknown)({ remoteJobId: data.remoteJobId, provider, http });
  }
  if (data.call === 'cancel') {
    const fn = adapter.cancel;
    if (typeof fn !== 'function') throw new Error('Adapter does not export cancel.');
    return await (fn as (input: unknown) => unknown)({ remoteJobId: data.remoteJobId, provider, http });
  }
  const fn = adapter.normalizeError;
  if (typeof fn !== 'function') throw new Error('Adapter does not export normalizeError.');
  return await (fn as (input: unknown) => unknown)(data.error);
}

void invoke().then((value) => {
  if (data.call !== 'cancel') assertBoundedAdapterData(value, MAX_WORKER_MESSAGE_BYTES);
  post({ kind: 'result', requestId: data.requestId, value });
}).catch((error: unknown) => {
  post({ kind: 'error', requestId: data.requestId, error: boundedError(error) });
});
