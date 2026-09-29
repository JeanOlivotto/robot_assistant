import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { LlmService, limparCitacoes, penaltyFor } from './llm.service.js';

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

  it('400 (errou o formato da ferramenta nesta mensagem): sem castigo', () => {
    expect(penaltyFor(Object.assign(new Error('400 Tool call validation failed'), { status: 400 }))).toBe(0);
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

describe('LlmService: reservaPrimeiro', () => {
  const make = () => {
    const svc = new LlmService({
      LLM_BASE_URL: 'https://api.groq.com/openai/v1',
      LLM_API_KEY: 'x',
      LLM_MODEL: 'grande',
      LLM_EXTRA_MODELS: '',
      LLM_FALLBACK_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      LLM_FALLBACK_API_KEY: 'y',
      LLM_FALLBACK_MODELS: 'lento',
    } as unknown as AppConfig);
    const groq = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'groq' } }] });
    const nvidia = vi.fn();
    const targets = (svc as unknown as { targets: { client: unknown }[] }).targets;
    targets[0]!.client = { chat: { completions: { create: groq } } };
    targets[1]!.client = { chat: { completions: { create: nvidia } } };
    return { svc, groq, nvidia };
  };

  it('vai na NVIDIA antes, sem gastar a cota do Groq', async () => {
    const { svc, groq, nvidia } = make();
    nvidia.mockResolvedValue({ choices: [{ message: { content: 'nvidia' } }] });
    expect((await svc.complete([{ role: 'user', content: 'oi' }], undefined, { reservaPrimeiro: true })).content).toBe('nvidia');
    expect(groq).not.toHaveBeenCalled();
  });

  it('NVIDIA fora do ar: cai no Groq', async () => {
    const { svc, groq, nvidia } = make();
    nvidia.mockRejectedValue(new Error('500'));
    expect((await svc.complete([{ role: 'user', content: 'oi' }], undefined, { reservaPrimeiro: true })).content).toBe('groq');
    expect(groq).toHaveBeenCalledOnce();
  });
});

describe('LlmService: dia ruim (Groq no limite, NVIDIA fora do ar)', () => {
  const make = () => {
    const svc = new LlmService({
      LLM_BASE_URL: 'https://api.groq.com/openai/v1',
      LLM_API_KEY: 'x',
      LLM_MODEL: 'grande',
      LLM_EXTRA_MODELS: '',
      LLM_FALLBACK_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      LLM_FALLBACK_API_KEY: 'y',
      LLM_FALLBACK_MODELS: 'lento',
    } as unknown as AppConfig);
    const grande = vi.fn();
    const lento = vi.fn();
    const targets = (svc as unknown as { targets: { client: unknown }[] }).targets;
    targets[0]!.client = { chat: { completions: { create: grande } } };
    targets[1]!.client = { chat: { completions: { create: lento } } };
    return { svc, grande, lento };
  };
  const limite = (s: number) => Object.assign(new Error(`429 Rate limit reached. Please try again in ${s}s.`), { status: 429 });
  const ok = (content: string) => ({ choices: [{ message: { content } }] });

  it('o Groq libera e pede mais um pouco: espera de novo, sem passar pela NVIDIA', async () => {
    const { svc, grande, lento } = make();
    grande.mockRejectedValueOnce(limite(0.02)).mockRejectedValueOnce(limite(0.01)).mockResolvedValue(ok('oi'));
    expect((await svc.complete([{ role: 'user', content: 'oi' }])).content).toBe('oi');
    expect(grande).toHaveBeenCalledTimes(3);
    expect(lento).not.toHaveBeenCalled();
  });

  it('NVIDIA que deu timeout há pouco não é tentada de novo antes do resto', async () => {
    const { svc, grande, lento } = make();
    lento.mockRejectedValue(new Error('Request timed out.'));
    grande.mockRejectedValueOnce(new Error('500')); // primeira mensagem: Groq caiu, NVIDIA não responde
    await expect(svc.complete([{ role: 'user', content: 'oi' }])).rejects.toThrow();
    expect(lento).toHaveBeenCalledTimes(1);

    // Segunda: Groq no limite por mais tempo do que dá para esperar — a NVIDIA de castigo fica
    // para o fim, e mesmo assim é tentada (é o que sobrou).
    grande.mockReset().mockRejectedValue(limite(60));
    await expect(svc.complete([{ role: 'user', content: 'oi' }])).rejects.toThrow();
    expect(lento).toHaveBeenCalledTimes(2);
  });

  it('o modelo errou o formato da ferramenta: a próxima mensagem volta nele', async () => {
    const { svc, grande, lento } = make();
    grande.mockRejectedValueOnce(Object.assign(new Error('400 Tool call validation failed'), { status: 400 })).mockResolvedValue(ok('grande'));
    lento.mockResolvedValue(ok('lento'));
    expect((await svc.complete([{ role: 'user', content: 'oi' }])).content).toBe('lento');
    expect((await svc.complete([{ role: 'user', content: 'de novo' }])).content).toBe('grande');
  });
});

describe('LlmService: pesquisar na internet', () => {
  const make = () => {
    const svc = new LlmService({
      LLM_BASE_URL: 'https://api.groq.com/openai/v1',
      LLM_API_KEY: 'x',
      LLM_MODEL: 'openai/gpt-oss-120b',
      LLM_EXTRA_MODELS: 'openai/gpt-oss-20b,qwen/qwen3.8-27b',
      LLM_FALLBACK_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      LLM_FALLBACK_API_KEY: 'y',
      LLM_FALLBACK_MODELS: 'lento',
    } as unknown as AppConfig);
    const creates = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const targets = (svc as unknown as { targets: { client: unknown }[] }).targets;
    creates.forEach((create, i) => (targets[i]!.client = { chat: { completions: { create } } }));
    const [grande, pequeno, qwen, nvidia] = creates as [ReturnType<typeof vi.fn>, ReturnType<typeof vi.fn>, ReturnType<typeof vi.fn>, ReturnType<typeof vi.fn>];
    return { svc, grande, pequeno, qwen, nvidia };
  };

  it('usa o 20b com a busca embutida (o limite por minuto do principal fica livre)', async () => {
    const { svc, grande, pequeno, qwen, nvidia } = make();
    pequeno.mockResolvedValue({ choices: [{ message: { content: 'Node 26.10.0 【1†L6-L8】. Fonte: nodejs.org' } }] });
    expect(await svc.pesquisar('versão do node')).toBe('Node 26.10.0. Fonte: nodejs.org');
    expect(pequeno.mock.calls[0]![0].tools).toEqual([{ type: 'browser_search' }]);
    expect(grande).not.toHaveBeenCalled();
    expect(qwen).not.toHaveBeenCalled();
    expect(nvidia).not.toHaveBeenCalled();
  });

  it('o 20b no limite: pesquisa pelo 120b', async () => {
    const { svc, grande, pequeno } = make();
    pequeno.mockRejectedValue(Object.assign(new Error('429'), { status: 429 }));
    grande.mockResolvedValue({ choices: [{ message: { content: 'achei' } }] });
    expect(await svc.pesquisar('x')).toBe('achei');
  });

  it('nenhum conseguiu: erro (o Miro diz que não achou, não inventa)', async () => {
    const { svc, grande, pequeno } = make();
    pequeno.mockRejectedValue(new Error('fora'));
    grande.mockResolvedValue({ choices: [{ message: { content: '' } }] });
    await expect(svc.pesquisar('x')).rejects.toThrow();
  });
});

describe('limparCitacoes', () => {
  it('tira as marcas do gpt-oss sem estragar o texto', () => {
    expect(limparCitacoes('É a 26.10.0 【1†L6-L8】 (Current) 【3†L1】.')).toBe('É a 26.10.0 (Current).');
  });
});
