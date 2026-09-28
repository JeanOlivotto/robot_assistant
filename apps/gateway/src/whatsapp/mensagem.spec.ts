import { describe, expect, it } from 'vitest';
import { acharPorNome, conteudo, descrever, type Recebida } from './mensagem.js';

describe('conteudo', () => {
  it('lê texto simples e texto com link/resposta', () => {
    expect(conteudo({ conversation: 'oi' })).toEqual({ tipo: 'texto', texto: 'oi' });
    expect(conteudo({ extendedTextMessage: { text: 'olha isso' } })).toEqual({ tipo: 'texto', texto: 'olha isso' });
  });

  it('tira o invólucro de mensagem temporária', () => {
    expect(conteudo({ ephemeralMessage: { message: { conversation: 'some em 7 dias' } } })).toEqual({ tipo: 'texto', texto: 'some em 7 dias' });
  });

  it('áudio vem com a duração; foto com a legenda', () => {
    expect(conteudo({ audioMessage: { seconds: 12 } })).toEqual({ tipo: 'audio', texto: '', segundos: 12 });
    expect(conteudo({ imageMessage: { caption: 'orçamento' } })).toEqual({ tipo: 'foto', texto: 'orçamento' });
  });

  it('reação e aviso de sistema não contam como mensagem', () => {
    expect(conteudo({ reactionMessage: { text: '👍' } })).toBeNull();
    expect(conteudo({ protocolMessage: {} })).toBeNull();
    expect(conteudo(null)).toBeNull();
  });
});

describe('acharPorNome', () => {
  const lista = [
    { id: '1', nome: 'Fábio Souza' },
    { id: '2', nome: 'Fabiana' },
    { id: '3', nome: 'Obra Casa Nova' },
    { id: '4', nome: 'Ana' },
    { id: '5', nome: 'Ana Paula' },
  ];

  it('acha pelo primeiro nome, sem acento e com artigo', () => {
    expect(acharPorNome(lista, 'o fabio').achou?.id).toBe('1');
  });

  it('nome igual ganha de quem só começa com ele', () => {
    expect(acharPorNome(lista, 'Ana').achou?.id).toBe('4');
  });

  it('acha grupo por uma palavra do nome', () => {
    expect(acharPorNome(lista, 'grupo da obra').achou?.id).toBe('3');
  });

  it('mais de um no mesmo nível é ambíguo', () => {
    const r = acharPorNome([...lista, { id: '6', nome: 'Fábio Lima' }], 'Fábio');
    expect(r.achou).toBeUndefined();
    expect(r.parecidos.map((p) => p.id).sort()).toEqual(['1', '6']);
  });

  it('a mesma conversa repetida não vira ambiguidade', () => {
    expect(acharPorNome([{ id: '1', nome: 'Fábio' }, { id: '1', nome: 'Fábio' }], 'fabio').achou?.id).toBe('1');
  });

  it('não acha pedaço de palavra', () => {
    expect(acharPorNome(lista, 'fab').achou).toBeUndefined();
  });
});

describe('descrever', () => {
  const base: Recebida = { id: 'x', chat: 'c', nomeChat: 'Fábio', autor: 'Fábio', grupo: false, ts: 0, tipo: 'texto', texto: 'bora?' };

  it('conversa direta', () => {
    expect(descrever(base, '14:30')).toBe('14:30 · Fábio: bora?');
  });

  it('grupo diz quem escreveu e onde', () => {
    expect(descrever({ ...base, grupo: true, nomeChat: 'Obra', autor: 'Ana' }, '09:00')).toBe('09:00 · Ana (no grupo "Obra"): bora?');
  });

  it('áudio com e sem transcrição', () => {
    const audio = { ...base, tipo: 'audio' as const, texto: '', segundos: 8 };
    expect(descrever(audio, '10:00', 'me liga depois')).toBe('10:00 · Fábio: [áudio] me liga depois');
    expect(descrever(audio, '10:00')).toBe('10:00 · Fábio: [áudio de 8s, sem transcrição]');
  });
});
