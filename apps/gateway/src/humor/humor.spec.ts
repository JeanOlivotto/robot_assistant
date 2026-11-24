import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { HumorService } from './humor.service.js';

const cfg = () => ({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-humor-')) }) as unknown as AppConfig;
const MIN = 60_000;

describe('HumorService', () => {
  it('a emoção forte dura e vai passando', () => {
    const h = new HumorService(cfg());
    const t0 = Date.now();
    h.sentiu('annoyed', 'faz de novo aquela mesma coisa', t0);
    expect(h.descricao(t0 + 40 * MIN)).toBe('irritado (faz uns 40 min, desde que ouviu: "faz de novo aquela mesma coisa")');
    expect(h.descricao(t0 + 2 * 60 * MIN)).toContain('irritado, já passando');
    expect(h.descricao(t0 + 3 * 60 * MIN)).toBe('');
  });

  it('carinha do momento não apaga o humor', () => {
    const h = new HumorService(cfg());
    const t0 = Date.now();
    h.sentiu('happy', undefined, t0);
    h.sentiu('thinking', 'hmm', t0 + MIN);
    h.sentiu('neutral', 'ok', t0 + 2 * MIN);
    expect(h.descricao(t0 + 3 * MIN)).toBe('de bom humor (agora há pouco)');
  });

  it('humor próprio: muda sozinho pelo dia dele, renova enquanto a coisa continua, e avisa a troca', () => {
    const h = new HumorService(cfg());
    const trocas: (string | null)[] = [];
    h.mudou$.subscribe((f) => trocas.push(f));
    const t0 = Date.now();
    expect(h.viver({ face: 'bored', porque: 'o Jean não falou com você o dia todo', forca: 1 }, t0)).toBe(true);
    expect(h.descricao(t0 + 30 * MIN)).toBe('entediado (faz uns 30 min, porque o Jean não falou com você o dia todo)');
    // continua sem ninguém falar: renova, não troca, e não passa depois de 3 h
    expect(h.viver({ face: 'bored', porque: 'o Jean não falou com você o dia todo', forca: 1 }, t0 + 150 * MIN)).toBe(false);
    expect(h.face(t0 + 200 * MIN)).toBe('bored');
    expect(h.motivoProprio(t0 + 200 * MIN)).toBe('o Jean não falou com você o dia todo');
    expect(trocas).toEqual(['bored']);
  });

  it('resposta alegre de rotina não apaga o humor próprio; emoção forte da conversa apaga', () => {
    const h = new HumorService(cfg());
    const t0 = Date.now();
    h.viver({ face: 'sad', porque: 'ficou no vácuo', forca: 2 }, t0);
    h.sentiu('happy', 'ok', t0 + 10 * MIN);
    expect(h.face(t0 + 11 * MIN)).toBe('sad');
    h.sentiu('annoyed', 'cala a boca', t0 + 12 * MIN);
    expect(h.face(t0 + 13 * MIN)).toBe('annoyed');
    // no meio da conversa, o dia não passa por cima
    expect(h.viver({ face: 'bored', porque: 'dia parado', forca: 1 }, t0 + 20 * MIN)).toBe(false);
    expect(h.face(t0 + 21 * MIN)).toBe('annoyed');
  });

  it('guarda as trocas do dia para o diário', () => {
    const h = new HumorService(cfg());
    const t0 = new Date('2026-11-24T10:00:00-03:00').getTime();
    h.viver({ face: 'bored', porque: 'dia parado', forca: 1 }, t0);
    h.sentiu('love', 'valeu miro', t0 + 60 * MIN);
    const dia = (ts: number) => new Date(ts - 3 * 3600_000).toISOString().slice(0, 10);
    expect(h.momentos('2026-11-24', dia).map((m) => [m.face, m.porque])).toEqual([
      ['bored', 'dia parado'],
      ['love', 'quando ele disse "valeu miro"'],
    ]);
  });

  it('lê o formato antigo do humor.json', () => {
    const c = cfg();
    const t0 = Date.now();
    writeFileSync(join(c.DATA_DIR, 'humor.json'), JSON.stringify({ face: 'happy', porque: 'bom dia', desde: t0 }));
    expect(new HumorService(c).face(t0 + MIN)).toBe('happy');
  });

  it('sobrevive a reiniciar', () => {
    const c = cfg();
    const t0 = Date.now();
    new HumorService(c).sentiu('sad', 'a cota acabou', t0);
    expect(new HumorService(c).descricao(t0 + 10 * MIN)).toContain('meio pra baixo');
  });
});
