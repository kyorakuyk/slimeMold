import { describe, it, expect, vi } from 'vitest';
import { Semaphore, sleep, withRetry } from './rateLimiter';
describe('Semaphore', () => {
  it('初始 permits 允许并发获取后释放', async () => {
    const sem = new Semaphore(2);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();
    expect(typeof release1).toBe('function');
    expect(typeof release2).toBe('function');
    release1();
    release2();
  });

  it('permits 最小为 1', async () => {
    const sem = new Semaphore(0);
    const release = await sem.acquire();
    expect(typeof release).toBe('function');
    release();
  });

  it('超额获取会被阻塞，释放后继续', async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();
    let secondAcquired = false;
    const p = sem.acquire().then((rel) => {
      secondAcquired = true;
      rel();
    });
    // 此时第二把仍阻塞
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    release1();
    await p;
    expect(secondAcquired).toBe(true);
  });

  it('acquire 时 signal 已中止直接 reject AbortError', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(sem.acquire(ctrl.signal)).rejects.toThrow('Aborted');
    release();
  });

  it('acquire 阻塞期间 signal 中止 reject AbortError', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const ctrl = new AbortController();
    const p = sem.acquire(ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow('Aborted');
    release();
  });
});

describe('sleep', () => {
  it('正常休眠后 resolve', async () => {
    const ctrl = new AbortController();
    const start = Date.now();
    await sleep(20, ctrl.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('休眠期间中止 reject AbortError', async () => {
    const ctrl = new AbortController();
    const p = sleep(1000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow('Aborted');
  });
});

describe('withRetry', () => {
  it('首次成功不重试', async () => {
    const ctrl = new AbortController();
    const fn = vi.fn().mockResolvedValue('ok');
    const onRetry = vi.fn();
    const res = await withRetry(fn, {
      retries: 3,
      baseDelay: 1,
      signal: ctrl.signal,
      onRetry,
    });
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('限流错误重试后成功', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const fn = vi.fn().mockImplementation(() => {
      calls++;
      if (calls < 3) return Promise.reject(new Error('429 Too Many Requests'));
      return Promise.resolve('done');
    });
    const onRetry = vi.fn();
    const res = await withRetry(fn, {
      retries: 3,
      baseDelay: 1,
      signal: ctrl.signal,
      onRetry,
    });
    expect(res).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('非限流错误不重试', async () => {
    const ctrl = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    const onRetry = vi.fn();
    await expect(
      withRetry(fn, { retries: 3, baseDelay: 1, signal: ctrl.signal, onRetry }),
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('超过重试次数后原样抛出', async () => {
    const ctrl = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('429 rate limit'));
    const onRetry = vi.fn();
    await expect(
      withRetry(fn, { retries: 2, baseDelay: 1, signal: ctrl.signal, onRetry }),
    ).rejects.toThrow('429 rate limit');
    expect(fn).toHaveBeenCalledTimes(3); // 首次 + 2 次重试
  });

  it('signal 中止时停止重试并抛出原始错误', async () => {
    const ctrl = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('429 rate limit'));
    const onRetry = vi.fn();
    ctrl.abort();
    await expect(
      withRetry(fn, { retries: 5, baseDelay: 1, signal: ctrl.signal, onRetry }),
    ).rejects.toThrow('429 rate limit');
    // 中止时不进入退避，仅调用一次
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
