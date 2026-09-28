import type { ChatMessage } from '@robo/protocol';
import { describe, expect, it } from 'vitest';
import { toLlmHistory } from './brain.service.js';

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
