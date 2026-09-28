import { describe, expect, it } from 'vitest';
import { lerSaida } from './atendente.service.js';

describe('lerSaida', () => {
  it('lê o JSON mesmo com cerca de markdown e texto em volta', () => {
    expect(lerSaida('claro:\n```json\n{"resposta":"Oi! Ele vê depois.","avisar":"a Jaque quer falar da nota"}\n```')).toEqual({
      resposta: 'Oi! Ele vê depois.',
      avisar: 'a Jaque quer falar da nota',
      expressao: '',
      figurinha: false,
      tom: 'brincadeira',
      pendencia: '',
      consulta: '',
    });
  });

  it('resposta vazia não manda nada', () => {
    expect(lerSaida('{"resposta":"","avisar":"x"}')).toBeNull();
    expect(lerSaida('   ')).toBeNull();
  });

  it('texto em vez de JSON vira a resposta (com a expressão, se vier)', () => {
    expect(lerSaida('[confuso] Mandarim eu não falo, mas aviso o Jean.')).toEqual({
      resposta: 'Mandarim eu não falo, mas aviso o Jean.',
      avisar: '',
      expressao: 'confuso',
      figurinha: false,
      tom: 'brincadeira',
      pendencia: '',
      consulta: '',
    });
  });

  it('avisar ausente vira vazio', () => {
    expect(lerSaida('{"resposta":"kkk boa"}')).toEqual({ resposta: 'kkk boa', avisar: '', expressao: '', figurinha: false, tom: 'brincadeira', pendencia: '', consulta: '' });
  });

  it('só a figurinha, sem texto, também vale', () => {
    expect(lerSaida('{"resposta":"","expressao":"irritado","figurinha":true}')).toEqual({
      resposta: '',
      avisar: '',
      expressao: 'irritado',
      figurinha: true,
      tom: 'brincadeira',
      pendencia: '',
      consulta: '',
    });
  });

  it('lê o tom e a pendência (sério, com ou sem acento)', () => {
    const s = lerSaida('{"resposta":"Beleza, aviso ele.","tom":"sério","avisar":"endpoints","pendencia":"Fazer os endpoints que alinhamos de manhã"}');
    expect(s?.tom).toBe('serio');
    expect(s?.pendencia).toBe('Fazer os endpoints que alinhamos de manhã');
  });

  it('dúvida de código vem em "consulta"', () => {
    expect(lerSaida('{"resposta":"pera","tom":"serio","consulta":"como funciona o login no previnity?"}')?.consulta).toBe(
      'como funciona o login no previnity?',
    );
  });

  it('expressão vem normalizada', () => {
    expect(lerSaida('{"resposta":"calma aí","expressao":"Bravo"}')?.expressao).toBe('bravo');
  });
});
