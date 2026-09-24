import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { IdentidadeService } from './identidade.service.js';

const cfg = () => ({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-id-')), ROBOT_NAME: 'Robô' }) as unknown as AppConfig;

describe('IdentidadeService', () => {
  it('começa com o nome da configuração e passa a usar o que ele escolheu', () => {
    const c = cfg();
    const eu = new IdentidadeService(c);
    expect(eu.nome).toBe('Robô');
    expect(eu.escolheuNome).toBe(false);
    eu.definirNome('  Bolt ');
    expect(new IdentidadeService(c).nome).toBe('Bolt'); // sobrevive a reinício
  });

  it('o mesmo assunto sobre si substitui o anterior, em vez de acumular', () => {
    const eu = new IdentidadeService(cfg());
    eu.lembrarDeMim('Gosto de música: rock dos anos 90');
    eu.lembrarDeMim('Gosto de música: agora jazz');
    eu.lembrarDeMim('Acho reunião longa um desperdício');
    expect(eu.sobre).toEqual(['Gosto de música: agora jazz', 'Acho reunião longa um desperdício']);
  });
});
