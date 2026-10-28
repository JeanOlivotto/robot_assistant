import { mkdtempSync } from 'node:fs';
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

  it('sobrevive a reiniciar', () => {
    const c = cfg();
    const t0 = Date.now();
    new HumorService(c).sentiu('sad', 'a cota acabou', t0);
    expect(new HumorService(c).descricao(t0 + 10 * MIN)).toContain('meio pra baixo');
  });
});
