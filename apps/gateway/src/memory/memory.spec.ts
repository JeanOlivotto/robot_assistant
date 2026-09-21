import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@robo/protocol';
import type { AppConfig } from '../config/app-config.js';
import type { LlmService } from '../llm/llm.service.js';
import { MemoryService } from './memory.service.js';

const cfg = () => ({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-mem-')) }) as unknown as AppConfig;
const llm = (content: string, enabled = true) => ({ enabled, complete: vi.fn().mockResolvedValue({ content }) }) as unknown as LlmService;
const userMsg = (text: string): ChatMessage => ({ id: '1', from: 'user', text, ts: Date.now() });

describe('MemoryService', () => {
  it('não duplica assunto igual (normalizado) e conta menções', () => {
    const m = new MemoryService(cfg(), llm(''));
    m.note('Projeto do robô');
    m.note('projeto do robo!');
    expect(m.all()).toHaveLength(1);
    expect(m.all()[0]!.mentions).toBe(2);
  });

  it('clear esquece tudo e sobrevive a recarregar do disco', () => {
    const c = cfg();
    const m = new MemoryService(c, llm(''));
    m.note('projeto do robô');
    m.note('academia às terças');
    expect(m.all()).toHaveLength(2);

    expect(m.clear()).toBe(2);
    expect(m.all()).toEqual([]);
    // Um serviço novo lê o mesmo arquivo: o esquecimento tem que ter ido para o disco.
    expect(new MemoryService(c, llm('')).all()).toEqual([]);
  });

  it('stale devolve o assunto mais antigo além do limite', () => {
    const m = new MemoryService(cfg(), llm(''));
    m.note('academia');
    m.all()[0]!.lastSeenAt = Date.now() - 10 * 24 * 3600_000; // 10 dias atrás
    expect(m.stale(4)?.texto).toBe('academia');
    expect(m.stale(30)).toBeNull();
  });

  it('learn extrai assuntos do JSON do LLM', async () => {
    const m = new MemoryService(cfg(), llm('```json\n{"assuntos":["mudança de casa","curso de inglês"]}\n```'));
    await m.learn([userMsg('tô me mudando e comecei um curso de inglês')]);
    expect(m.summaries()).toEqual(expect.arrayContaining(['mudança de casa', 'curso de inglês']));
  });

  it('learn ignora resposta sem JSON', async () => {
    const m = new MemoryService(cfg(), llm('nada de relevante aqui'));
    await m.learn([userMsg('oi')]);
    expect(m.all()).toHaveLength(0);
  });

  it('learn persiste em disco e recarrega', async () => {
    const c = cfg();
    await new MemoryService(c, llm('{"assuntos":["novo emprego"]}')).learn([userMsg('consegui um novo emprego')]);
    expect(new MemoryService(c, llm('')).summaries()).toContain('novo emprego');
  });
});
