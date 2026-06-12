import * as Comlink from 'comlink';
import type { EngineAPI } from './worker';

let worker: Worker | null = null;
let engineProxy: Comlink.Remote<EngineAPI> | null = null;
let workerFailed = false;

function createWorker(): Worker {
  const w = new Worker(
    new URL('./worker.ts', import.meta.url),
    { type: 'module' },
  );
  // A worker-level error (uncaught exception, failed module load, WASM
  // panic that kills the thread) leaves any in-flight Comlink calls
  // permanently pending. Flag the failure so callers can recover via
  // resetEngine() instead of waiting forever.
  w.onerror = (e) => {
    workerFailed = true;
    console.error('Engine worker error:', e);
  };
  w.onmessageerror = (e) => {
    workerFailed = true;
    console.error('Engine worker message error:', e);
  };
  return w;
}

export function getEngine(): Comlink.Remote<EngineAPI> {
  if (!engineProxy) {
    worker = createWorker();
    engineProxy = Comlink.wrap<EngineAPI>(worker);
  }
  return engineProxy;
}

/** True if the worker has reported a fatal error since the last reset. */
export function isEngineFailed(): boolean {
  return workerFailed;
}

/**
 * Terminate the (possibly poisoned) worker and discard the proxy. The next
 * getEngine() call creates a fresh worker with a fresh WASM instance.
 * Callers must re-run init() after this — any pending calls on the old
 * proxy will never settle.
 */
export async function resetEngine(): Promise<void> {
  if (worker) {
    worker.terminate();
  }
  worker = null;
  engineProxy = null;
  workerFailed = false;
}
