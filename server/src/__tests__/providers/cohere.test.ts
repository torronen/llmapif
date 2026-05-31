import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CohereProvider } from '../../providers/cohere.js';

describe('CohereProvider', () => {
  let provider: CohereProvider;

  beforeEach(async () => {
    provider = new CohereProvider();
  });

  it('should have correct platform and name', async () => {
    expect(provider.platform).toBe('cohere');
    expect(provider.name).toBe('Cohere');
  });

  it('should call compatibility API and return OpenAI response', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'cohere-123',
          object: 'chat.completion',
          created: 123,
          model: 'command-a-03-2025',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from Cohere!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'command-r-plus-08-2024',
      {
        max_tokens: 100,
        temperature: 0.7,
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
            },
          },
        }],
      },
    );

    expect(capturedUrl).toContain('/compatibility/v1/chat/completions');
    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.max_tokens).toBe(100);
    expect(capturedBody.temperature).toBe(0.7);
    expect(result.object).toBe('chat.completion');
    expect(result.choices[0].message.content).toBe('Hello from Cohere!');
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result._routed_via?.platform).toBe('cohere');
  });

  it('should stream chat completion', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    vi.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: true,
      body: { getReader: () => stream.getReader() }
    } as any));

    const gen = provider.streamChatCompletion('my-token', [{ role: 'user', content: 'hello' }], 'command-r');
    const chunks = [];
    for await (const chunk of gen) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].delta.content).toBe('Hi');
  });

  it('should validate key successfully', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ models: [] })
    } as any));

    const isValid = await provider.validateKey('valid');
    expect(isValid).toBe(true);
  });

  it('should return false for invalid key on 401', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: false,
      status: 401
    } as any));

    const isValid = await provider.validateKey('token');
    expect(isValid).toBe(false);
  });
});
