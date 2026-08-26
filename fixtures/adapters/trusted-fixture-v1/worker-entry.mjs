import { parentPort, workerData } from 'node:worker_threads';
import { Buffer } from 'node:buffer';

if (parentPort === null) throw new Error('fixture worker requires parentPort');

const data = workerData;
const pending = new Map();
let sequence = 0;

parentPort.on('message', (message) => {
  if (message?.kind !== 'http-result' || typeof message.requestId !== 'string') return;
  const callback = pending.get(message.requestId);
  if (!callback) return;
  pending.delete(message.requestId);
  if (message.ok) callback.resolve(message.value);
  else callback.reject(new Error(message.error?.message ?? 'HTTP request failed'));
});

parentPort.on('close', () => {
  for (const callback of pending.values()) callback.reject(new Error('Adapter worker host closed.'));
  pending.clear();
});

function httpRequest(input) {
  const requestId = `${data.requestId}:http:${sequence++}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try {
      if (!post({ kind: 'http-request', requestId, input })) {
        pending.delete(requestId);
        reject(new Error('Adapter worker host closed.'));
      }
    } catch (error) {
      pending.delete(requestId);
      reject(error);
    }
  });
}

function post(value) {
  try {
    parentPort.postMessage(value);
    return true;
  } catch {
    return false;
  }
}

async function loadAdapter() {
  const source = Buffer.from(data.source, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${source}`);
}

async function invoke() {
  const adapter = await loadAdapter();
  const provider = data.provider;
  const http = { request: httpRequest };
  if (data.call === 'capabilities') return typeof adapter.capabilities === 'function' ? adapter.capabilities() : adapter.capabilities;
  if (data.call === 'submit') return adapter.submit({ request: data.request, provider, http, files: data.files ?? [] });
  if (data.call === 'poll') return adapter.poll({ remoteJobId: data.remoteJobId, provider, http });
  if (data.call === 'cancel') return adapter.cancel({ remoteJobId: data.remoteJobId, provider, http });
  return adapter.normalizeError(data.error);
}

void invoke().then((value) => {
  post({ kind: 'result', requestId: data.requestId, value });
}).catch((error) => {
  post({ kind: 'error', requestId: data.requestId, error: { name: error?.name ?? 'Error', message: String(error?.message ?? error).slice(0, 1024) } });
});
