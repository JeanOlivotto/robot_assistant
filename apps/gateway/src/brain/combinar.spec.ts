import { describe, expect, it } from 'vitest';
import { faltaCombinar } from './brain.service.js';

describe('faltaCombinar: responder no lugar dele só liga depois de combinado', () => {
  it('só o "responde meu zap": pergunta recado e grupos', () => {
    expect(faltaCombinar({ contatos: ['Fábio'] })).toHaveLength(2);
  });

  it('com "todos", pergunta também quem ignorar', () => {
    expect(faltaCombinar({ todos: true, recado: '', grupos: false })).toEqual(['se tem alguém (contato ou grupo) para ignorar']);
  });

  it('respondido (mesmo "nenhum recado, ninguém, sem grupo"): liga', () => {
    expect(faltaCombinar({ todos: true, recado: '', exceto: [], grupos: false })).toEqual([]);
  });
});
