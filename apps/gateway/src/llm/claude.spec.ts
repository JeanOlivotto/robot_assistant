import { describe, expect, it } from 'vitest';
import { paraClaude } from './claude.js';

describe('paraClaude', () => {
  it('system do meio vira aviso no turno do usuário; conversa começa e termina no usuário', () => {
    const r = paraClaude([
      { role: 'system', content: 'prompt' },
      { role: 'assistant', content: 'oi, sou o Miro' },
      { role: 'user', content: 'e aí' },
      { role: 'system', content: 'fique quieto se não for com você' },
    ]);
    expect(r.system).toBe('prompt');
    expect(r.messages).toEqual([
      { role: 'user', content: '(conversa em andamento)' },
      { role: 'assistant', content: [{ type: 'text', text: 'oi, sou o Miro' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'e aí' },
          { type: 'text', text: '[instrução interna do sistema] fique quieto se não for com você' },
        ],
      },
    ]);
  });

  it('resultados de várias ferramentas vão juntos, numa mensagem só', () => {
    const r = paraClaude([
      { role: 'user', content: 'faz tudo' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'x', arguments: '{"n":1}' } },
          { id: 'b', type: 'function', function: { name: 'y', arguments: 'quebrado' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: 'ok' },
      { role: 'tool', tool_call_id: 'b', content: 'ok' },
    ]);
    expect(r.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 'x', input: { n: 1 } },
        { type: 'tool_use', id: 'b', name: 'y', input: {} },
      ],
    });
    expect(r.messages[2]!.content).toHaveLength(2);
  });
});
