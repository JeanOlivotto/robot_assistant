import type { ChatMessage } from '@robo/protocol';
import { describe, expect, it } from 'vitest';
import { gruposDaConversa } from './ferramentas.js';

let n = 0;
const dele = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${n++}`, from: 'user', text, ts: Date.now(), ...extra });
const doRobo = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${n++}`, from: 'robot', text, ts: Date.now(), ...extra });
const grupos = (h: ChatMessage[]) => [...gruposDaConversa(h)].sort();

describe('gruposDaConversa', () => {
  it('papo à toa não leva grupo nenhum (só agenda, pendências e internet)', () => {
    expect(grupos([dele('bom dia! como você tá?')])).toEqual([]);
    expect(grupos([dele('me lembra de pagar o boleto amanhã')])).toEqual([]);
  });

  it('o assunto puxa o grupo, com ou sem acento', () => {
    expect(grupos([dele('responde o Fábio por mim até as 18h')])).toEqual(['whatsapp']);
    expect(grupos([dele('o que a Duda mandou no zap?')])).toEqual(['whatsapp']);
    expect(grupos([dele('roda os testes no computador')])).toEqual(['computador']);
    expect(grupos([dele('a partir de agora você é mais sério')])).toEqual(['ajustes']);
    expect(grupos([dele('esquece aquilo, era só teste')])).toEqual(['ajustes']);
  });

  it('mandar um arquivo com resumo leva WhatsApp e computador', () => {
    expect(grupos([dele('manda o pdf do contrato pro Fábio com um resumo')])).toEqual(['computador', 'whatsapp']);
    expect(grupos([dele('me faz um resumo daquela planilha')])).toEqual(['computador']);
  });

  it('"sim" depois de uma proposta de mensagem continua sendo WhatsApp', () => {
    const proposta = doRobo('Mando isso pra Duda?', {
      proposal: { id: 'p', kind: 'whatsapp', title: 'Mensagem para Duda' } as ChatMessage['proposal'],
    });
    expect(grupos([dele('avisa ela'), proposta, dele('pode ser mais curto')])).toContain('whatsapp');
    expect(grupos([doRobo('💬 Fábio me chamou no WhatsApp: quer o orçamento', { kind: 'whatsapp' }), dele('beleza, e aí?')])).toEqual([
      'whatsapp',
    ]);
  });

  it('voz sem certeza leva as ferramentas de voz', () => {
    expect(grupos([dele('oi', { voz: { certeza: 'duvida', nome: 'Jean' } })])).toEqual(['vozes']);
    expect(grupos([dele('oi', { voz: { certeza: 'alta', nome: 'Jean' } })])).toEqual([]);
  });
});
