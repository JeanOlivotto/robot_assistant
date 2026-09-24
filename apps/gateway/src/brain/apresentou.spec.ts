import { describe, expect, it } from 'vitest';
import { apresentou } from './brain.service.js';

describe('apresentou: o nome veio de uma apresentação de verdade?', () => {
  it('aceita os jeitos comuns de se apresentar, com ou sem acento', () => {
    expect(apresentou('Oi, eu sou a Francisca, tudo bem?', 'Francisca')).toBe(true);
    expect(apresentou('Meu nome é Fábio.', 'Fabio')).toBe(true);
    expect(apresentou('Aqui é o Jean', 'Jean')).toBe(true);
    expect(apresentou('me chamo Ana', 'Ana')).toBe(true);
  });

  it('recusa palavra solta que parece nome (a transcrição inventando)', () => {
    expect(apresentou('Gui, pahala.', 'Gui')).toBe(false); // era "opa, pode falar"
    expect(apresentou('Manda um abraço pro Fábio', 'Fábio')).toBe(false);
    expect(apresentou('Oi, sou a Francisca', 'Ana')).toBe(false);
  });
});
