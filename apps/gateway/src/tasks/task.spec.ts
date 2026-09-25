import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { TaskService } from './task.service.js';

const make = () => new TaskService({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-task-')) } as unknown as AppConfig);

describe('TaskService', () => {
  it('anota, lista e conclui', () => {
    const svc = make();
    const t = svc.add('Mandar mensagem para o Fábio', { pessoa: 'Fábio', origem: 'ata' })!;
    expect(t.pessoa).toBe('Fábio');
    expect(svc.open()).toHaveLength(1);

    svc.done(t.id);
    expect(svc.open()).toEqual([]);
    expect(svc.all()).toHaveLength(1); // concluída continua no histórico
  });

  it('não duplica a mesma pendência escrita de outro jeito', () => {
    const svc = make();
    const a = svc.add('Mandar mensagem para o Fábio')!;
    const b = svc.add('mandar mensagem para o fabio!')!;
    expect(b.id).toBe(a.id);
    expect(svc.open()).toHaveLength(1);
  });

  it('depois de concluída, a mesma frase abre uma nova', () => {
    const svc = make();
    const a = svc.add('Responder a proposta')!;
    svc.done(a.id);
    const b = svc.add('Responder a proposta')!;
    expect(b.id).not.toBe(a.id);
    expect(svc.open()).toHaveLength(1);
  });

  it('recusa texto curto demais', () => {
    expect(make().add('ok')).toBeNull();
  });

  it('só devolve para cobrar o que não foi cobrado há pouco', () => {
    const svc = make();
    const t = svc.add('Ligar para o contador')!;
    expect(svc.worthNudging(20)).toHaveLength(1);

    svc.nudged([t.id]);
    expect(svc.worthNudging(20)).toEqual([]); // acabou de cobrar, deixa quieto
    expect(svc.open()[0]!.nudges).toBe(1);

    // um dia depois, volta a valer a pena lembrar
    svc.open()[0]!.lastNudgeAt = Date.now() - 25 * 3600_000;
    expect(svc.worthNudging(20)).toHaveLength(1);
  });

  it('cobrar não mexe no que já foi concluído', () => {
    const svc = make();
    const t = svc.add('Comprar café')!;
    svc.done(t.id);
    svc.nudged([t.id]);
    expect(svc.all()[0]!.nudges).toBe(0);
  });

  it('sobrevive a reiniciar o servidor', () => {
    const cfg = { DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-task-')) } as unknown as AppConfig;
    const svc = new TaskService(cfg);
    svc.add('Revisar o contrato');
    expect(new TaskService(cfg).open()).toHaveLength(1);
  });
});

describe('TaskService: renomear e juntar', () => {
  it('juntar várias pendências deixa uma só, com o texto novo', () => {
    const svc = new TaskService({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-tasks-')) } as unknown as AppConfig);
    const a = svc.add('Refazer notificações dos 600 contribuintes')!;
    const b = svc.add('Abrir ticket de higienização da base')!;
    svc.add('Comprar café');
    const t = svc.juntar([a.id, b.id], 'Pendências de Itabirito')!;
    expect(svc.open().map((x) => x.texto)).toEqual(['Pendências de Itabirito', 'Comprar café']);
    expect(svc.renomear(t.id, 'Itabirito: notificações e higienização')?.texto).toBe('Itabirito: notificações e higienização');
    expect(svc.juntar([a.id], 'só uma')).toBeNull(); // juntar precisa de duas
  });
});
