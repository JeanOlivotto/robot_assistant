import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { InviteService } from './invite.service.js';

const make = () =>
  new InviteService({
    DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-conv-')),
    PUBLIC_URL: 'https://exemplo.test',
  } as unknown as AppConfig);

describe('InviteService', () => {
  it('cria um link com o convite na query', () => {
    const svc = make();
    const c = svc.create('Reunião com o Fábio');
    expect(c.url).toBe(`https://exemplo.test/?convite=${c.token}`);
    expect(svc.check(c.token)?.titulo).toBe('Reunião com o Fábio');
  });

  it('cada convite tem um token só dele', () => {
    const svc = make();
    const tokens = new Set(Array.from({ length: 5 }, () => svc.create('x').token));
    expect(tokens.size).toBe(5);
  });

  it('recusa token desconhecido, vazio ou vencido', () => {
    const svc = make();
    expect(svc.check('nao-existe')).toBeNull();
    expect(svc.check('')).toBeNull();
    expect(svc.check(undefined)).toBeNull();

    const c = svc.create('vence');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 13 * 3600_000); // 13 h depois
    expect(svc.check(c.token)).toBeNull();
    vi.restoreAllMocks();
  });

  it('anota as reuniões do convidado sem repetir', () => {
    const svc = make();
    const c = svc.create('reunião');
    svc.note(c.token, 'm1');
    svc.note(c.token, 'm1');
    svc.note(c.token, 'm2');
    expect(svc.check(c.token)?.meetings).toEqual(['m1', 'm2']);
    expect(svc.list()[0]?.meetings).toBe(2);
  });

  it('a listagem não entrega os tokens', () => {
    const svc = make();
    const c = svc.create('reunião');
    expect(JSON.stringify(svc.list())).not.toContain(c.token);
  });
});
