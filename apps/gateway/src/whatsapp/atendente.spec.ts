import { describe, expect, it } from 'vitest';
import { lerSaida } from './atendente.service.js';

describe('lerSaida', () => {
  it('lê o JSON mesmo com cerca de markdown e texto em volta', () => {
    expect(lerSaida('claro:\n```json\n{"resposta":"Oi! Ele vê depois.","avisar":"a Jaque quer falar da nota"}\n```')).toEqual({
      resposta: 'Oi! Ele vê depois.',
      avisar: 'a Jaque quer falar da nota',
      expressao: '',
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
    });
  });

  it('avisar ausente vira vazio', () => {
    expect(lerSaida('{"resposta":"kkk boa"}')).toEqual({ resposta: 'kkk boa', avisar: '', expressao: '' });
  });

  it('expressão vem normalizada', () => {
    expect(lerSaida('{"resposta":"calma aí","expressao":"Bravo"}')?.expressao).toBe('bravo');
  });
});
