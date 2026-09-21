import type { AntigravityMode } from '../../types/agent';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../../platform/env';

export type { AntigravityMode };

export interface AntigravityWorkerResponse {
  text: string;
  outcome: 'completed' | 'blocked';
  sessionDir: string;
}

export interface AntigravityWorkerInvoker {
  execute(input: {
    prompt: string;
    cwd: string;
    operationId: string;
    context: unknown;
    signal?: AbortSignal;
  }): Promise<AntigravityWorkerResponse>;
}

export interface AntigravityWorkerInvokerOptions {
  generation: number;
  mode?: AntigravityMode;
  profile?: string;
  cliPath?: string;
}

export function createAntigravityWorkerInvoker(
  options: AntigravityWorkerInvokerOptions,
): AntigravityWorkerInvoker {
  if (!Number.isSafeInteger(options.generation) || options.generation <= 0) {
    throw new Error('Antigravity Worker session generation is required');
  }
  const mode = options.mode ?? 'agent';
  return {
    async execute({ prompt, cwd, operationId, context, signal }): Promise<AntigravityWorkerResponse> {
      if (!isTauri) throw new Error('Antigravity Worker 需要 SlimeMold 桌面版。');
      if (signal?.aborted) throw new Error('Antigravity Worker 请求已取消');
      const onAbort = () => {
        void invoke('antigravity_worker_cancel', { operationId });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await invoke<AntigravityWorkerResponse>('antigravity_worker_exec', {
          request: {
            prompt,
            cwd,
            operationId,
            generation: options.generation,
            mode,
            profile: options.profile?.trim() || null,
            cliPath: options.cliPath?.trim() || null,
            context,
          },
        });
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
