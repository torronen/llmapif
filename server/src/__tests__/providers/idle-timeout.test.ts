import { describe, it, expect } from 'vitest';
import { BaseProvider } from '../../providers/base.js';

// Minimal concrete subclass to exercise the protected helper.
class TestProvider extends BaseProvider {
  readonly platform = 'groq' as const;
  readonly name = 'Test';
  async chatCompletion(): Promise<any> { throw new Error('not used'); }
  async *streamChatCompletion(): AsyncGenerator<any> { /* not used */ }
  async validateKey(): Promise<boolean> { return true; }

  read(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number) {
    return this.readChunkWithIdleTimeout(reader, idleMs);
  }
}

function readerFrom(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  }).getReader();
}

// A reader whose read() never resolves — simulates a stalled upstream.
function stalledReader(): ReadableStreamDefaultReader<Uint8Array> {
  let cancelled = false;
  return {
    read: () => new Promise(() => { /* never resolves */ }),
    cancel: async () => { cancelled = true; },
    releaseLock: () => {},
    get closed() { return Promise.resolve(undefined as any); },
    _cancelled: () => cancelled,
  } as any;
}

describe('readChunkWithIdleTimeout', () => {
  const provider = new TestProvider();

  it('returns chunks normally when data flows', async () => {
    const reader = readerFrom([new Uint8Array([1, 2, 3])]);
    const { done, value } = await provider.read(reader, 1000);
    expect(done).toBe(false);
    expect(Array.from(value!)).toEqual([1, 2, 3]);
  });

  it('signals done at end of stream', async () => {
    const reader = readerFrom([]);
    const { done } = await provider.read(reader, 1000);
    expect(done).toBe(true);
  });

  it('rejects with an idle-timeout error when the upstream stalls', async () => {
    const reader = stalledReader();
    await expect(provider.read(reader, 20)).rejects.toThrow(/idle timeout/i);
    expect((reader as any)._cancelled()).toBe(true);
  });
});
