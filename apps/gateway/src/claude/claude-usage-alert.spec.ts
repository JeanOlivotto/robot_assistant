import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import type { PushService } from '../push/push.service.js';
import type { RobotStateService } from '../robot/robot-state.service.js';
import { ClaudeUsageAlertService } from './claude-usage-alert.service.js';
import { ClaudeUsageService } from './claude-usage.service.js';

const RESET_5H = 1_790_000_000; // segundos
const RESET_WEEK = 1_790_500_000;

function make(percents = [50, 80, 95]) {
  const dir = mkdtempSync(join(tmpdir(), 'robo-usagealert-'));
  const cfg = { DATA_DIR: dir, TZ_NAME: 'America/Sao_Paulo', CLAUDE_ALERT_PERCENTS: percents } as unknown as AppConfig;
  const usage = new ClaudeUsageService(cfg);
  const push = { notify: vi.fn().mockResolvedValue(1) } as unknown as PushService;
  const say = vi.fn();
  const robot = { say } as unknown as RobotStateService;
  const alert = new ClaudeUsageAlertService(cfg, usage, push, robot);
  alert.onModuleInit();
  return { usage, push, say, alert, cfg, dir };
}

const report = (usage: ClaudeUsageService, five: number, week = 0) =>
  usage.report({ five_hour: { used_percentage: five, resets_at: RESET_5H }, seven_day: { used_percentage: week, resets_at: RESET_WEEK } });

describe('ClaudeUsageAlertService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('avisa ao cruzar um limite, uma vez só', () => {
    const { usage, push, say } = make();
    report(usage, 40);
    expect(push.notify).not.toHaveBeenCalled();
    report(usage, 82); // cruza 50 e 80 de uma vez → avisa só o maior
    expect(push.notify).toHaveBeenCalledTimes(1);
    expect((push.notify as any).mock.calls[0][0].body).toContain('80%');
    expect(say).toHaveBeenCalledWith('Sessao 5h em 80%');
    report(usage, 83); // mesmo patamar → não repete
    expect(push.notify).toHaveBeenCalledTimes(1);
  });

  it('sobe de patamar avisa de novo', () => {
    const { usage, push } = make();
    report(usage, 82);
    report(usage, 96);
    expect(push.notify).toHaveBeenCalledTimes(2);
    expect((push.notify as any).mock.calls[1][0].body).toContain('95%');
  });

  it('avisa quando a janela renova', () => {
    const { usage, push } = make();
    report(usage, 82); // 1 aviso de patamar
    // nova janela: resets_at bem diferente e uso zerado
    usage.report({
      five_hour: { used_percentage: 3, resets_at: RESET_5H + 20_000 },
      seven_day: { used_percentage: 0, resets_at: RESET_WEEK },
    });
    expect(push.notify).toHaveBeenCalledTimes(2);
    expect((push.notify as any).mock.calls[1][0].body).toContain('renovada');
  });

  it('não repete avisos após reiniciar (estado em disco)', () => {
    const { usage, cfg, push } = make();
    report(usage, 82);
    expect(push.notify).toHaveBeenCalledTimes(1);
    // "reinício": novo serviço, mesmo DATA_DIR
    const push2 = { notify: vi.fn().mockResolvedValue(1) } as unknown as PushService;
    const alert2 = new ClaudeUsageAlertService(cfg, usage, push2, { say: vi.fn() } as unknown as RobotStateService);
    alert2.onModuleInit();
    report(usage, 83);
    expect(push2.notify).not.toHaveBeenCalled();
  });

  it('percents vazio desliga os avisos', () => {
    const { usage, push } = make([]);
    report(usage, 99);
    expect(push.notify).not.toHaveBeenCalled();
  });
});
