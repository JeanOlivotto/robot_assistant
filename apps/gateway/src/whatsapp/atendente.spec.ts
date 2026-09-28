import { describe, expect, it } from 'vitest';
import { lerSaida } from './atendente.service.js';

describe('lerSaida', () => {
  it('lê o JSON mesmo com cerca de markdown e texto em volta', () => {
    expect(lerSaida('claro:\n```json\n{"resposta":"Oi! Ele vê depois.","avisar":"a Jaque quer falar da nota"}\n```')).toEqual({
      resposta: 'Oi! Ele vê depois.',
      avisar: 'a Jaque quer falar da nota',
    });
  });

  it('sem resposta, ou sem JSON, não manda nada', () => {
    expect(lerSaida('{"resposta":"","avisar":"x"}')).toBeNull();
    expect(lerSaida('não sei')).toBeNull();
  });

  it('avisar ausente vira vazio', () => {
    expect(lerSaida('{"resposta":"kkk boa"}')).toEqual({ resposta: 'kkk boa', avisar: '' });
  });
});
