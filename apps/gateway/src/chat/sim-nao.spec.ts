import { describe, expect, it } from 'vitest';
import { simOuNao } from './sim-nao.js';

describe('sim ou não para a proposta em aberto', () => {
  it('sim, do jeito que se fala', () => {
    for (const t of ['sim', 'Sim!', 'pode mandar', 'sim, pode mandar', 'manda aí', 'pode', 'ok', 'beleza, manda', 'pode gravar', 'grava', 'isso, confirma', 'manda ver', 'pode sim por favor']) {
      expect(simOuNao(t, ['Miro']), t).toBe(true);
    }
  });

  it('com o nome dele na frente também', () => {
    expect(simOuNao('Miro, pode mandar', ['Miro'])).toBe(true);
    expect(simOuNao('miro não', ['Miro'])).toBe(false);
  });

  it('não', () => {
    for (const t of ['não', 'Nao.', 'cancela', 'deixa pra lá', 'não precisa', 'esquece', 'não, valeu']) {
      expect(simOuNao(t), t).toBe(false);
    }
  });

  it('frase com mais coisa é pedido novo, não resposta', () => {
    for (const t of ['não, manda em áudio', 'sim mas muda o horário', 'manda outra mensagem mais queria que mandasse em audio', 'pode mandar pro Eduardo também', 'que horas são?', '']) {
      expect(simOuNao(t, ['Miro']), t).toBe(null);
    }
  });
});
