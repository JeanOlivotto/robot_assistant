import type { ChatMessage } from '@robo/protocol';
import { describe, expect, it } from 'vitest';
import { rotuloDoDia, toLlmHistory } from './brain.service.js';

const robo = (text: string, kind: ChatMessage['kind']): ChatMessage => ({ id: text, from: 'robot', text, ts: 0, kind });

describe('toLlmHistory: recados do WhatsApp', () => {
  it('chegam marcados como recado — a pessoa citada não está na conversa', () => {
    const [m] = toLlmHistory([robo('💬 João Vitor me chamou no WhatsApp: agradeceu a ajuda', 'whatsapp')], 'America/Sao_Paulo');
    expect(m!.content).toMatch(/^\[recado do WhatsApp que você repassou ao dono — quem é citado aqui não está nesta conversa\] 💬 João Vitor/);
  });

  it('os antigos (gravados como proactive) também', () => {
    const [m] = toLlmHistory([robo('📌 Andre no WhatsApp: endpoints', 'proactive')], 'America/Sao_Paulo');
    expect(m!.content).toMatch(/^\[recado do WhatsApp/);
  });

  it('fala espontânea dele continua igual', () => {
    const [m] = toLlmHistory([robo('Bom dia. Agenda vazia hoje.', 'proactive')], 'America/Sao_Paulo');
    expect(m!.content).toBe('Bom dia. Agenda vazia hoje.');
  });
});

describe('toLlmHistory: conversa de outros dias', () => {
  const tz = 'America/Sao_Paulo';
  const agora = new Date('2026-10-28T08:00:00-03:00');
  const msg = (text: string, iso: string): ChatMessage => ({ id: iso, from: 'robot', text, ts: new Date(iso).getTime(), kind: 'proactive' });

  it('tudo de hoje: nenhum marcador', () => {
    const out = toLlmHistory([msg('Bom dia', '2026-10-28T07:30:00-03:00')], tz, agora);
    expect(out).toHaveLength(1);
  });

  it('o "amanhã" de ontem à noite vem marcado como de ontem', () => {
    const out = toLlmHistory(
      [msg('Não esquece do auto process da COMPESA amanhã às 08:00.', '2026-10-27T21:31:00-03:00'), msg('Bom dia', '2026-10-28T07:30:00-03:00')],
      tz,
      agora,
    );
    expect(out.map((m) => m.role)).toEqual(['system', 'assistant', 'system', 'assistant']);
    expect(out[0]!.content).toContain('ontem (ter 27/10)');
    expect(out[0]!.content).toContain('relativos àquele dia');
    expect(out[2]!.content).toBe('[daqui para baixo é a conversa de hoje]');
  });

  it('rotuloDoDia', () => {
    expect(rotuloDoDia(new Date('2026-10-28T00:10:00-03:00').getTime(), agora, tz)).toBe('hoje');
    expect(rotuloDoDia(new Date('2026-10-22T12:00:00-03:00').getTime(), agora, tz)).toBe('qui 22/10');
  });
});
