/** 信号量：限制同时进行的异步任务数量（用于 LLM 并发限流） */
export class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, permits);
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return () => this.release();
    }
    return new Promise((resolve, reject) => {
      const entry: { resolve: () => void; reject?: (err: Error) => void } = {
        resolve: () => {
          this.permits--;
          resolve(() => this.release());
        },
      };
      // 若 signal 已中止或随后中止，直接 reject 让调用方抛 AbortError
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onAbort = () => {
        const idx = this.queue.indexOf(entry as unknown as () => void);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(() => {
        signal?.removeEventListener('abort', onAbort);
        (entry as { resolve: () => void }).resolve();
      });
    });
  }

  private release(): void {
    this.permits++;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** 受 AbortSignal 控制的可中断休眠 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 判断错误是否为限流（速率限制）类错误，可重试 */
function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /(?:429|rate[ _-]?limit|too many requests|resource has been exhausted)/i.test(msg);
}

/**
 * 带指数退避的重试包装。默认仅对限流类错误重试（默认 3 次），
 * 遇到 AbortSignal 中止或达到重试上限则原样抛出。
 * 可通过 `shouldRetry` 覆盖重试判定（如节点级「仅瞬时错误重试」）。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    retries: number;
    baseDelay: number;
    signal: AbortSignal;
    onRetry: (msg: string, delay: number, attempt: number) => void;
    shouldRetry?: (err: unknown) => boolean;
  },
): Promise<T> {
  const decide = opts.shouldRetry ?? isRateLimitError;
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (opts.signal.aborted || !decide(err) || attempt >= opts.retries) {
        throw err;
      }
      attempt++;
      const delay = opts.baseDelay * 2 ** (attempt - 1);
      opts.onRetry(err instanceof Error ? err.message : String(err), delay, attempt);
      await sleep(delay, opts.signal);
    }
  }
}
