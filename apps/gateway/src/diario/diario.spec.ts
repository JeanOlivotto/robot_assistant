import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@robo/protocol';
import type { AppConfig } from '../config/app-config.js';
import type { LlmService } from '../llm/llm.service.js';
import { DiarioService } from './diario.service.js';

const cfg = () => ({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-diario-')), TZ_NAME: 'America/Sao_Paulo', OWNER_NAME: 'Jean' }) as unknown as AppConfig;
const llm = (content: string) => ({ enabled: true, complete: vi.fn().mockResolvedValue({ content }) }) as unknown as LlmService & { complete: ReturnType<typeof vi.fn> };
const msg = (from: 'user' | 'robot', text: string, iso: string): ChatMessage => ({ id: iso, from, text, ts: new Date(iso).getTime() });

describe('DiarioService', () => {
  const ontem = [msg('user', 'preciso ajustar o auto process da COMPESA', '2026-10-27T20:00:00-03:00'), msg('robot', 'Amanhã às 8 eu te lembro.', '2026-10-27T20:01:00-03:00')];
  const hoje = new Date('2026-10-28T09:00:00-03:00');

  it('anota o dia e entra como "ontem" no dia seguinte', async () => {
    const c = cfg();
    const l = llm('Ele ficou preocupado com o auto process da COMPESA; quero perguntar se saiu.');
    const d = new DiarioService(c, l);
    await d.escrever('2026-10-27', ontem);
    expect(d.recentes(hoje)).toEqual(['ontem (ter 27/10): Ele ficou preocupado com o auto process da COMPESA; quero perguntar se saiu.']);
    // Só a conversa daquele dia vai para o LLM.
    expect(String(l.complete.mock.calls[0]![0][1].content)).toContain('Jean: preciso ajustar o auto process');
    // Sobrevive a reiniciar e não escreve de novo.
    const d2 = new DiarioService(c, l);
    expect(d2.tem('2026-10-27')).toBe(true);
    await d2.escrever('2026-10-27', ontem);
    expect(l.complete).toHaveBeenCalledTimes(1);
  });

  it('dia sem fala do dono não vira anotação', async () => {
    const l = llm('nada');
    const d = new DiarioService(cfg(), l);
    await d.escrever('2026-10-27', [msg('robot', 'Bom dia', '2026-10-27T08:00:00-03:00')]);
    expect(l.complete).not.toHaveBeenCalled();
    expect(d.recentes(hoje)).toEqual([]);
  });
});
