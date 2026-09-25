import { describe, expect, it } from 'vitest';
import { comandoPeloNome } from './chamado.js';

/* Transcrições do Whisper grande das frases que o Jean gravou em 25/09. */
describe('comandoPeloNome', () => {
  it('pega o chamado e devolve só o comando', () => {
    expect(comandoPeloNome('Miro, grava a reunião.', 'Miro')).toBe('grava a reunião.');
    expect(comandoPeloNome('Ei Miro, o que eu tenho amanhã?', 'Miro')).toBe('o que eu tenho amanhã?');
    expect(comandoPeloNome('Ô Miro, que horas são?', 'Miro')).toBe('que horas são?');
    expect(comandoPeloNome('Miros, onde', 'Miro')).toBe('onde');
  });

  it('não dispara com o nome no meio, com palavra parecida ou sem o nome', () => {
    expect(comandoPeloNome('Primeiro, vou terminar esse relatório.', 'Miro')).toBeNull();
    expect(comandoPeloNome('Ontem eu falei com o Miro sobre isso.', 'Miro')).toBeNull();
    expect(comandoPeloNome('Mira aquele ali, que coisa.', 'Miro')).toBeNull();
    expect(comandoPeloNome('Tá bom, depois a gente vê isso com calma.', 'Miro')).toBeNull();
  });
});
