import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { LlmService, penaltyFor } from './llm.service.js';

describe('penaltyFor', () => {
  it('limite por minuto: espera só o que o provedor pediu (+1 s)', () => {
    const err = Object.assign(new Error('429 Rate limit reached … Please try again in 14.8125s. Need more tokens?'), { status: 429 });
    expect(penaltyFor(err)).toBe(15_813);
  });

  it('429 sem prazo: um minuto', () => {
    expect(penaltyFor(Object.assign(new Error('429 Too Many Requests'), { status: 429 }))).toBe(60_000);
  });

  it('outras falhas (timeout, 500): fica de lado 5 min', () => {
    expect(penaltyFor(new Error('Request timed out.'))).toBe(5 * 60_000);
  });
});

describe('LlmService: todos os rápidos no limite', () => {
  it('espera o Groq liberar em vez de cair na reserva lenta', async () => {
    const svc = new LlmService({
      LLM_BASE_URL: 'https://api.groq.com/openai/v1',
      LLM_API_KEY: 'x',
      LLM_MODEL: 'grande',
      LLM_EXTRA_MODELS: 'pequeno',
      LLM_FALLBACK_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      LLM_FALLBACK_API_KEY: 'y',
      LLM_FALLBACK_MODELS: 'lento',
    } as unknown as AppConfig);
    const limite = () => Object.assign(new Error('429 Rate limit reached. Please try again in 0.05s.'), { status: 429 });
    const grande = vi.fn().mockRejectedValueOnce(limite()).mockResolvedValue({ choices: [{ message: { content: 'oi' } }] });
    const pequeno = vi.fn().mockRejectedValue(limite());
    const lento = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'demorei' } }] });
    const targets = (svc as unknown as { targets: { client: unknown }[] }).targets;
    [grande, pequeno, lento].forEach((create, i) => (targets[i]!.client = { chat: { completions: { create } } }));

    const msg = await svc.complete([{ role: 'user', content: 'oi' }]);
    expect(msg.content).toBe('oi');
    expect(lento).not.toHaveBeenCalled();
  });
});
