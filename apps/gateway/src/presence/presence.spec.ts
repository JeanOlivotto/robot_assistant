import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { PresenceService } from './presence.service.js';

const cfg = () => ({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-pres-')) }) as unknown as AppConfig;
const ble = (dev: { a: string; r: number; k: number }[]) => ({ t: 'ble' as const, ts: Date.now(), n: dev.length, ads: dev.length, dev });

describe('PresenceService', () => {
  afterEach(() => vi.useRealTimers());

  it('resume o minuto pelo sinal mais forte, separando o Nearby Info', () => {
    vi.useFakeTimers({ now: new Date('2026-09-24T12:00:05Z') });
    const svc = new PresenceService(cfg());
    svc.record(ble([{ a: 'aa', r: -70, k: 0x10 }, { a: 'bb', r: -45, k: 0x07 }]));
    vi.advanceTimersByTime(10_000);
    svc.record(ble([{ a: 'aa', r: -52, k: 0x10 }]));

    expect(svc.history(1)).toEqual([{ at: Date.parse('2026-09-24T12:00:00Z'), best: -45, nearby: -52, devices: 2, present: true }]);
  });

  it('minuto sem nada ouvido fica null, e o histórico sobrevive a um reinício', () => {
    vi.useFakeTimers({ now: new Date('2026-09-24T12:00:05Z') });
    const c = cfg();
    const svc = new PresenceService(c);
    svc.record(ble([]));
    vi.advanceTimersByTime(60_000);
    svc.record(ble([{ a: 'aa', r: -80, k: 0x10 }])); // virar o minuto grava o anterior

    const depois = new PresenceService(c);
    expect(depois.history(1)).toEqual([{ at: Date.parse('2026-09-24T12:00:00Z'), best: null, nearby: null, devices: 0, present: false }]);
  });

  it('iPhone bloqueado some por minutos: a janela de 5 min segura a presença', () => {
    vi.useFakeTimers({ now: new Date('2026-09-24T12:00:05Z') });
    const svc = new PresenceService(cfg());
    svc.record(ble([{ a: 'aa', r: -45, k: 0x10 }]));
    expect(svc.isPresent).toBe(true);

    vi.advanceTimersByTime(4 * 60_000); // só aparelhos longe nesse tempo
    svc.record(ble([{ a: 'bb', r: -78, k: 0x10 }]));
    expect(svc.isPresent).toBe(true);

    vi.advanceTimersByTime(2 * 60_000); // passou dos 5 min sem o sinal forte
    svc.record(ble([{ a: 'bb', r: -78, k: 0x10 }]));
    expect(svc.isPresent).toBe(false);
  });
});
