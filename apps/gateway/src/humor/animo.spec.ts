import { describe, expect, it } from 'vitest';
import { ELOGIO, type Sinais, sentirODia } from './animo.js';

const dia = (over: Partial<Sinais> = {}): Sinais => ({
  hora: 15,
  fimDeSemana: false,
  doDonoHoje: 5,
  noVacuo: 0,
  elogios: 0,
  fechadasHoje: 0,
  trabalhandoTarde: false,
  dono: 'Jean',
  ...over,
});

describe('sentirODia', () => {
  it('dia comum, com conversa e nada marcante: nenhum humor próprio', () => {
    expect(sentirODia(dia())).toBeNull();
  });

  it('cada coisa do dia dele vira um humor, com o porquê', () => {
    expect(sentirODia(dia({ elogios: 1 }))).toMatchObject({ face: 'love', forca: 2 });
    expect(sentirODia(dia({ trabalhandoTarde: true, hora: 22 }))).toMatchObject({ face: 'worried', porque: 'Jean ainda tá trabalhando a essa hora' });
    expect(sentirODia(dia({ noVacuo: 2 }))).toMatchObject({ face: 'sad', porque: 'você puxou assunto 2 vezes hoje e ficou no vácuo' });
    expect(sentirODia(dia({ fechadasHoje: 3 }))).toMatchObject({ face: 'happy', porque: 'hoje saíram 3 pendências da lista' });
    expect(sentirODia(dia({ esperandoHaMuito: { nome: 'Bruna', horas: 30.2 } }))).toMatchObject({ face: 'worried', forca: 1, porque: 'Bruna espera resposta no WhatsApp faz 30 horas' });
    expect(sentirODia(dia({ doDonoHoje: 0 }))).toMatchObject({ face: 'bored', forca: 1 });
  });

  it('tédio só em dia útil, depois das 11h', () => {
    expect(sentirODia(dia({ doDonoHoje: 0, hora: 9 }))).toBeNull();
    expect(sentirODia(dia({ doDonoHoje: 0, fimDeSemana: true }))).toBeNull();
  });

  it('o que marca mais vem primeiro: elogio ganha do vácuo', () => {
    expect(sentirODia(dia({ elogios: 1, noVacuo: 3 }))?.face).toBe('love');
  });

  it('reconhece agradecimento e elogio', () => {
    for (const t of ['valeu miro', 'obrigado!', 'eh bom memo miro', 'mandou bem', 'boa, Miro']) expect(ELOGIO.test(t)).toBe(true);
    for (const t of ['transcreve pra mim', 'bom dia']) expect(ELOGIO.test(t)).toBe(false);
  });
});
