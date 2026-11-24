import { describe, expect, it } from 'vitest';
import { Esperas, pedeResposta } from './esperando.js';
import type { Recebida } from './mensagem.js';

const H = 3600_000;
const msg = (over: Partial<Recebida> = {}): Recebida => ({
  id: 'x',
  chat: 'bruna@lid',
  alt: '5511@s.whatsapp.net',
  nomeChat: 'Bruna',
  autor: 'Bruna',
  grupo: false,
  ts: 0,
  tipo: 'texto',
  texto: 'travou de novo, consegue ver?',
  ...over,
});

describe('pedeResposta', () => {
  it('pergunta no privado pede; "ok", "valeu", kkk e figurinha não', () => {
    expect(pedeResposta(msg())).toBe(true);
    expect(pedeResposta(msg({ tipo: 'audio', texto: '' }))).toBe(true);
    for (const t of ['ok', 'Valeu!', 'obrigada', 'kkkkk', 'blz', '👍', '🙏🏻']) expect(pedeResposta(msg({ texto: t }))).toBe(false);
    expect(pedeResposta(msg({ tipo: 'figurinha', texto: '' }))).toBe(false);
  });

  it('num grupo, só o que é com ele', () => {
    expect(pedeResposta(msg({ grupo: true }))).toBe(false);
    expect(pedeResposta(msg({ grupo: true, paraDono: true }))).toBe(true);
  });
});

describe('Esperas', () => {
  it('soma as mensagens da mesma conversa e sai quando ele responde (por qualquer jid)', () => {
    const e = new Esperas();
    const t0 = 100 * H;
    e.chegou(msg({ ts: t0 }));
    e.chegou(msg({ ts: t0 + 60_000, tipo: 'audio' }));
    e.chegou(msg({ ts: t0 + 120_000, tipo: 'audio' }));
    const [b] = e.abertas(t0 + H);
    expect(b).toMatchObject({ nome: 'Bruna', desde: t0, mensagens: 3, audios: 2 });

    expect(e.respondeu('5511@s.whatsapp.net')).toBe(true); // respondeu pelo número, chegou pelo LID
    expect(e.abertas(t0 + H)).toEqual([]);
  });

  it('só conta depois de um tempo esperando, e esquece o que ficou velho demais', () => {
    const e = new Esperas();
    const t0 = 100 * H;
    e.chegou(msg({ ts: t0 }));
    expect(e.abertas(t0 + 10 * 60_000)).toEqual([]); // dez minutos: ainda não está esperando
    expect(e.abertas(t0 + H)).toHaveLength(1);
    expect(e.abertas(t0 + 5 * 24 * H)).toEqual([]);
  });

  it('ordena das mais antigas para as mais novas', () => {
    const e = new Esperas();
    e.chegou(msg({ chat: 'a', alt: undefined, nomeChat: 'Kleber', ts: 50 * H }));
    e.chegou(msg({ chat: 'b', alt: undefined, nomeChat: 'Jaque', ts: 40 * H }));
    expect(e.abertas(60 * H).map((x) => x.nome)).toEqual(['Jaque', 'Kleber']);
  });
});
