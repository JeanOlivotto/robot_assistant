import { describe, expect, it } from 'vitest';
import { repeteFala, semFechoDeSac } from './brain.service.js';

describe('repeteFala', () => {
  it('pega a resposta quase igual à anterior', () => {
    const antes = ['Tudo tranquilo, agenda vazia hoje. E você, como tá?'];
    expect(repeteFala('Tudo tranquilo, agenda vazia hoje. E você?', antes)).toBe(antes[0]);
  });

  it('deixa passar resposta diferente e frase curtinha', () => {
    expect(repeteFala('Pô, férias merecidas. Vai viajar pra onde?', ['Tudo tranquilo, agenda vazia hoje.'])).toBeNull();
    expect(repeteFala('Beleza.', ['Beleza.'])).toBeNull();
  });
});

describe('semFechoDeSac', () => {
  it('corta o fecho de atendente quando sobra conteúdo', () => {
    expect(semFechoDeSac('Tudo resolvido então. Se precisar de algo mais, avisa.')).toBe('Tudo resolvido então.');
    expect(semFechoDeSac('Fechado, sem lembrete. Me chama se precisar.')).toBe('Fechado, sem lembrete.');
  });

  it('não mexe no resto', () => {
    expect(semFechoDeSac('Se precisar de algo, avisa.')).toBe('Se precisar de algo, avisa.');
    expect(semFechoDeSac('Se precisar de ajuda com o deploy, eu olho o log contigo.')).toBe('Se precisar de ajuda com o deploy, eu olho o log contigo.');
  });
});
