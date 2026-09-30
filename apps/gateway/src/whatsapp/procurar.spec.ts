import { describe, expect, it } from 'vitest';
import { digitosDe, jidDoNumero, type Lembranca, numeroBate, porAssunto } from './procurar.js';

const l = (chat: string, texto: string, ts: number, nome = chat): Lembranca => ({ chat, nome, grupo: false, autor: nome, texto, ts });

describe('achar o cliente sem saber o nome', () => {
  it('número: o final, o inteiro com ou sem 55 — mas nome com número no meio é nome', () => {
    expect(digitosDe('final 4321')).toBe('4321');
    expect(digitosDe('o número que termina em 43-21')).toBe('4321');
    expect(digitosDe('(11) 98888-7777')).toBe('11988887777');
    expect(digitosDe('Turma 2024')).toBe(null);
    expect(digitosDe('final 12')).toBe(null);
    expect(numeroBate('5511988887777@s.whatsapp.net', '7777')).toBe(true);
    expect(numeroBate('5511988887777:3@s.whatsapp.net', '11988887777')).toBe(true);
    expect(numeroBate('123456789@lid', '6789')).toBe(false);
    expect(jidDoNumero('11988887777')).toBe('5511988887777@s.whatsapp.net');
    expect(jidDoNumero('4321')).toBe(null);
  });

  it('assunto: acha pelo começo da palavra, a conversa que mais bate primeiro, uma vez por conversa', () => {
    const achados = porAssunto(
      [
        l('a', 'bom dia, tudo bem?', 1),
        l('b', 'preciso das notas fiscais de setembro', 2),
        l('c', 'a nota do mercado chegou', 3),
        l('b', 'e a nota fiscal de outubro também', 4),
      ],
      'o cliente que falou da nota fiscal ontem',
    );
    expect(achados.map((x) => x.l.chat)).toEqual(['b', 'c']);
    expect(achados[0]!.l.texto).toContain('outubro'); // empate: a mais recente
    expect(porAssunto([l('a', 'oi', 1)], 'o cliente que mandou mensagem ontem')).toEqual([]); // nada de assunto no pedido
  });
});
