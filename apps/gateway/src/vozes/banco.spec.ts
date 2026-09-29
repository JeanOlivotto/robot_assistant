import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { BancoVozesService, type VozConhecida } from './banco.service.js';

const cfg = () => ({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-vozes-')) }) as unknown as AppConfig;
/* Assinaturas de mentira: vetores quase paralelos são "a mesma voz". */
const JEAN = [1, 0.1, 0, 0];
const JEAN_OUTRO_DIA = [0.95, 0.2, 0.05, 0];
const FABIO = [0, 0, 1, 0.1];
const PARECIDO = [0.55, 0, 0.8, 0]; // ~0,58 com o Jean: reconhece, mas sem folga

describe('BancoVozesService', () => {
  it('reconhece quem já foi cadastrado, e ninguém mais', () => {
    const b = new BancoVozesService(cfg());
    b.cadastrar('Jean', JEAN);
    b.cadastrar('Fábio', FABIO);
    expect(b.identificar(JEAN_OUTRO_DIA)).toMatchObject({ nome: 'Jean', certeza: 'alta' });
    expect(b.identificar(FABIO)).toMatchObject({ nome: 'Fábio' });
    expect(b.identificar([0, 1, 0, 0])).toBeNull();
  });

  it('voz meio parecida vem como dúvida, para ele confirmar', () => {
    const b = new BancoVozesService(cfg());
    b.cadastrar('Jean', JEAN);
    const r = b.identificar([0.5, 0, 0.8, 0]);
    expect(r?.certeza).toBe('duvida');
  });

  it('o mesmo nome (com ou sem acento) acumula amostras em vez de duplicar', () => {
    const b = new BancoVozesService(cfg());
    b.cadastrar('Fábio', FABIO);
    b.cadastrar('fabio', [0, 0.1, 1, 0]);
    expect(b.listar()).toEqual([expect.objectContaining({ nome: 'Fábio', amostras: 2 })]);
  });

  it('sobrevive a reinício e dá para apagar', () => {
    const c = cfg();
    const b = new BancoVozesService(c);
    const v = b.cadastrar('Jean', JEAN);
    const depois = new BancoVozesService(c);
    expect(depois.identificar(JEAN)?.nome).toBe('Jean');
    expect(depois.remover(v.id)).toBe(true);
    expect(new BancoVozesService(c).listar()).toEqual([]);
  });

  it('só reforça o cadastro quando reconheceu com folga', () => {
    const b = new BancoVozesService(cfg());
    b.cadastrar('Jean', JEAN);
    b.reforcar(b.identificar(JEAN_OUTRO_DIA)!, JEAN_OUTRO_DIA);
    expect(b.listar()[0]!.amostras).toBe(2);
    b.reforcar(b.identificar(PARECIDO)!, PARECIDO); // reconhece, mas não o bastante para reforçar
    expect(b.listar()[0]!.amostras).toBe(2);
  });
});

describe('BancoVozesService: voz pendente do chat', () => {
  it('guarda a voz desconhecida até alguém dizer o nome, uma vez só', () => {
    const b = new BancoVozesService(cfg());
    expect(b.salvarPendente('Fábio')).toEqual({ erro: 'sem-voz' }); // nada esperando
    b.guardarPendente(FABIO);
    expect((b.salvarPendente('Fábio') as VozConhecida).nome).toBe('Fábio');
    expect(b.identificar(FABIO)?.nome).toBe('Fábio');
    expect(b.salvarPendente('Outro')).toEqual({ erro: 'sem-voz' }); // já foi usada
  });

  it('"sou o Jean" com outra voz: recusa, e o cadastro do Jean continua só com a voz dele', () => {
    const b = new BancoVozesService(cfg());
    b.cadastrar('Jean', JEAN);
    b.guardarPendente(FABIO);
    expect(b.salvarPendente('Jean')).toEqual({ erro: 'outra-voz', nome: 'Jean' });
    expect(b.salvarPendente('jean')).toEqual({ erro: 'outra-voz', nome: 'Jean' }); // sem diferença de maiúscula
    expect(b.listar()).toEqual([expect.objectContaining({ nome: 'Jean', amostras: 1 })]);
    expect(b.identificar(FABIO)).toBeNull();
    // A voz continua esperando: dizendo o nome de verdade, entra.
    expect((b.salvarPendente('Fábio') as VozConhecida).nome).toBe('Fábio');
  });

  it('o próprio Jean, reconhecido só na dúvida, confirma e a amostra entra', () => {
    const b = new BancoVozesService(cfg());
    b.cadastrar('Jean', JEAN);
    b.guardarPendente(PARECIDO);
    expect((b.salvarPendente('Jean') as VozConhecida).amostras).toHaveLength(2);
  });

  it('voz que já é de alguém não vira outra pessoa', () => {
    const b = new BancoVozesService(cfg());
    b.cadastrar('Jean', JEAN);
    b.guardarPendente(JEAN_OUTRO_DIA);
    expect(b.salvarPendente('Carlos')).toEqual({ erro: 'ja-e-de', nome: 'Jean' });
    expect(b.listar()).toHaveLength(1);
  });
});

describe('BancoVozesService: esquecer', () => {
  it('"esquece a minha voz" apaga pelo nome, com ou sem acento', () => {
    const b = new BancoVozesService(cfg());
    b.cadastrar('Fábio', FABIO);
    expect(b.removerPorNome('fabio')).toBe(true);
    expect(b.identificar(FABIO)).toBeNull();
    expect(b.removerPorNome('Fábio')).toBe(false);
  });
});

describe('BancoVozesService: renomear', () => {
  it('corrige o nome salvo errado, e junta se o certo já existir', () => {
    const b = new BancoVozesService(cfg());
    b.cadastrar('Gui', JEAN);
    expect((b.renomear('gui', 'Jean') as VozConhecida).nome).toBe('Jean');
    expect(b.identificar(JEAN)?.nome).toBe('Jean');

    b.cadastrar('Jeann', JEAN_OUTRO_DIA);
    expect((b.renomear('Jeann', 'Jean') as VozConhecida).amostras).toHaveLength(2);
    expect(b.listar()).toEqual([expect.objectContaining({ nome: 'Jean', amostras: 2 })]);
    expect(b.renomear('Ninguém', 'X')).toBeNull();
  });

  it('renomear para o nome de outra voz não junta as duas', () => {
    const b = new BancoVozesService(cfg());
    b.cadastrar('Jean', JEAN);
    b.cadastrar('Carlos', FABIO);
    expect(b.renomear('Carlos', 'Jean')).toEqual({ erro: 'outra-voz', nome: 'Jean' });
    expect(b.listar()).toHaveLength(2);
    expect(b.identificar(FABIO)?.nome).toBe('Carlos');
  });
});
