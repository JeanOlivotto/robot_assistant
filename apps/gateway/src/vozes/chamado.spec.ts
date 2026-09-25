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

  it('chamados naturais que antes passavam batido', () => {
    expect(comandoPeloNome('Ok Miro, abre o navegador.', 'Miro')).toBe('abre o navegador.');
    expect(comandoPeloNome('Beleza, Miro, cria uma página.', 'Miro')).toBe('cria uma página.');
    expect(comandoPeloNome('Bom dia Miro, o que tem hoje?', 'Miro')).toBe('o que tem hoje?');
    expect(comandoPeloNome('Tá muito alto isso. Miro, pausa a música.', 'Miro')).toBe('pausa a música.');
    expect(comandoPeloNome('Que horas são, Miro?', 'Miro')).toBe('Que horas são');
    expect(comandoPeloNome('[música] Miro, abre o Spotify.', 'Miro')).toBe('abre o Spotify.');
    expect(comandoPeloNome('Niro, abre o AnyDesk.', 'Miro')).toBe('abre o AnyDesk.');
    expect(comandoPeloNome('Miro?', 'Miro')).toBe('');
    // o Whisper grande ouviu assim o "Miro, esconde" do dono
    expect(comandoPeloNome('Mira, esconde.', 'Miro')).toBe('esconde.');
  });

  it('e o que continua não sendo chamado', () => {
    expect(comandoPeloNome('Eu vou falar com o Miro, depois.', 'Miro')).toBeNull();
    expect(comandoPeloNome('Ontem eu falei com o Miro.', 'Miro')).toBeNull();
    expect(comandoPeloNome('Bom, primeiro vou almoçar.', 'Miro')).toBeNull();
    expect(comandoPeloNome('Ele disse que o número era mero detalhe.', 'Miro')).toBeNull();
  });
});

