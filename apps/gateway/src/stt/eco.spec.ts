import { describe, expect, it } from 'vitest';
import { ecoDaDica } from './stt.service.js';

describe('ecoDaDica', () => {
  it('reconhece o Whisper devolvendo a dica em cima do silêncio', () => {
    expect(ecoDaDica('Nomes, Jeean. Nome.')).toBe(true);
    expect(ecoDaDica('Nomes: Jean.')).toBe(true);
    expect(ecoDaDica('Nome. Nome. Nome. Nome. Nome.')).toBe(true); // o "sim" do lembrete virou isso
  });
  it('não confunde com fala de verdade', () => {
    expect(ecoDaDica('Meu nome é Jean.')).toBe(false);
    expect(ecoDaDica('Nomes dos clientes que faltam ligar hoje à tarde')).toBe(false);
    expect(ecoDaDica('Oi robô, tudo certo?')).toBe(false);
  });
});
