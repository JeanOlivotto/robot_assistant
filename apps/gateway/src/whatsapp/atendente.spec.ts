import { describe, expect, it } from 'vitest';
import { lerSaida, pedidoDeContato } from './atendente.service.js';

describe('lerSaida', () => {
  it('lê o JSON mesmo com cerca de markdown e texto em volta', () => {
    expect(lerSaida('claro:\n```json\n{"resposta":"Oi! Ele vê depois.","avisar":"a Jaque quer falar da nota"}\n```')).toEqual({
      resposta: 'Oi! Ele vê depois.',
      avisar: 'a Jaque quer falar da nota',
      expressao: '',
      figurinha: false,
      audio: false,
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
      audio: false,
      tom: 'brincadeira',
      pendencia: '',
      consulta: '',
    });
  });

  it('avisar ausente vira vazio', () => {
    expect(lerSaida('{"resposta":"kkk boa"}')).toEqual({ resposta: 'kkk boa', avisar: '', expressao: '', figurinha: false, audio: false, tom: 'brincadeira', pendencia: '', consulta: '' });
  });

  it('só a figurinha, sem texto, também vale', () => {
    expect(lerSaida('{"resposta":"","expressao":"irritado","figurinha":true}')).toEqual({
      resposta: '',
      avisar: '',
      expressao: 'irritado',
      figurinha: true,
      audio: false,
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

  it('"audio": true pede a resposta em voz', () => {
    expect(lerSaida('{"resposta":"Pô, que isso, relaxa aí","audio":true}')?.audio).toBe(true);
    expect(lerSaida('{"resposta":"oi"}')?.audio).toBe(false);
  });

  it('"calar": ficar quieto quando não era com ele', () => {
    expect(lerSaida('{"calar": true}')?.calar).toBe(true);
    // Mandou calar mas também escreveu: vale a resposta.
    expect(lerSaida('{"calar": true, "resposta": "opa"}')?.calar).toBeUndefined();
  });

  it('expressão vem normalizada', () => {
    expect(lerSaida('{"resposta":"calma aí","expressao":"Bravo"}')?.expressao).toBe('bravo');
  });
});

describe('lerSaida: no lugar do dono', () => {
  it('"importante" vem quando chega algo que ele precisa ver', () => {
    expect(lerSaida('{"resposta":"Recebi, ele vê.","importante":"comprovante do Pix de R$ 300"}')?.importante).toBe('comprovante do Pix de R$ 300');
    expect(lerSaida('{"resposta":"kkk","importante":""}')?.importante).toBeUndefined();
  });
});

describe('quem insiste no lugar do dono', () => {
  it('"encaminhar" vem com o que a pessoa precisa', () => {
    expect(lerSaida('{"resposta":"Vou pedir pra alguém da equipe te chamar.","encaminhar":"orçamento do site até sexta"}')?.encaminhar).toBe('orçamento do site até sexta');
    expect(lerSaida('{"resposta":"oi","encaminhar":" "}')?.encaminhar).toBeUndefined();
  });

  it('o pedido de contato leva nome, número e o que quer', () => {
    expect(pedidoDeContato('Carla', '+5511988887777', 'orçamento do site', 'Jean')).toBe(
      'Carla está tentando falar com Jean e insistiu. Pode entrar em contato?\nContato: Carla — +5511988887777\nO que precisa: orçamento do site',
    );
    expect(pedidoDeContato('Carla', '', 'x', 'Jean', 'Obra')).toContain('Contato: Carla (número não disponível) (no grupo Obra)');
  });
});
