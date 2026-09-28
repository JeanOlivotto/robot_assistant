import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { SilencioService } from './silencio.service.js';

const cfg = () => ({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-sil-')), TZ_NAME: 'America/Sao_Paulo' }) as unknown as AppConfig;
// 26/09/2026 é sábado; 28/09/2026 é segunda. Meio-dia em São Paulo = 15h UTC.
const sabado = new Date('2026-09-26T15:00:00Z');
const segunda = new Date('2026-09-28T15:00:00Z');

describe('SilencioService', () => {
  it('sem nada combinado, fim de semana é folga', () => {
    const s = new SilencioService(cfg());
    expect(s.motivo(sabado)).toMatch(/sábado/);
    expect(s.motivo(segunda)).toBeNull();
  });

  it('pausa até um dia vale até aquele dia e sobrevive a reinício', () => {
    const c = cfg();
    const s = new SilencioService(c);
    s.definirFolgas([]);
    s.pausarAte(new Date('2026-09-28T03:00:00Z')); // segunda 00:00 em SP
    expect(new SilencioService(c).motivo(sabado)).toMatch(/pausa/);
    expect(new SilencioService(c).motivo(segunda)).toBeNull();
  });

  it('retomar acaba com a pausa; folgas trocam a lista inteira', () => {
    const s = new SilencioService(cfg());
    s.pausarAte(new Date('2030-01-01T00:00:00Z'));
    s.retomar();
    s.definirFolgas([1, 1, 9]);
    expect(s.folgas).toEqual([1]);
    expect(s.motivo(sabado)).toBeNull();
    expect(s.motivo(segunda)).toMatch(/segunda/);
  });
});
