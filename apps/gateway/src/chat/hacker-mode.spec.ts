import { describe, expect, it } from 'vitest';

/* As mesmas expressões do chat.service.ts — se mudarem lá, este teste tem que acompanhar. */
const HACKER_OFF = /\b(sa[ií]r?|sai|desliga\w*|tira\w*|encerra\w*|volta\w*)\b[^.]{0,20}\bhacker\b/i;
const HACKER_ON = /\bmodo hacker\b/i;

const decide = (t: string): boolean | null => (HACKER_OFF.test(t) ? false : HACKER_ON.test(t) ? true : null);

describe('modo hacker na conversa', () => {
  it('liga quando o dono pede', () => {
    for (const t of ['modo hacker', 'entra em modo hacker', 'Robô, ativa o MODO HACKER aí', 'bota no modo hacker']) {
      expect(decide(t)).toBe(true);
    }
  });

  it('desliga — e "sair do modo hacker" não pode ser lido como pedido para ligar', () => {
    for (const t of ['sai do modo hacker', 'sair do modo hacker', 'desliga o modo hacker', 'volta do modo hacker']) {
      expect(decide(t)).toBe(false);
    }
  });

  it('não reage a conversa comum', () => {
    for (const t of ['me conta sobre hackers', 'aquele filme de hacker é bom', 'bom dia', 'que horas são?']) {
      expect(decide(t)).toBe(null);
    }
  });
});
