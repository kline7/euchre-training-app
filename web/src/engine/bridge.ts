import * as Comlink from 'comlink';
import type { EngineAPI } from './worker';

let engineProxy: Comlink.Remote<EngineAPI> | null = null;

export function getEngine(): Comlink.Remote<EngineAPI> {
  if (!engineProxy) {
    const worker = new Worker(
      new URL('./worker.ts', import.meta.url),
      { type: 'module' },
    );
    engineProxy = Comlink.wrap<EngineAPI>(worker);
  }
  return engineProxy;
}
