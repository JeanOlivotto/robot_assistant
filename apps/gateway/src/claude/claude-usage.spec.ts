import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { ClaudeUsageService } from './claude-usage.service.js';

const fresh = () => new ClaudeUsageService({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-usage-')) } as AppConfig);

describe('ClaudeUsageService', () => {
  it('converte o rate_limits do Claude Code (segundos) para epoch ms', () => {
    const svc = fresh();
    const u = svc.report({
      rate_limits: {
        five_hour: { used_percentage: 23.456, resets_at: 1_790_000_000 },
        seven_day: { used_percentage: 41, resets_at: 1_790_500_000 },
      },
    });
    expect(u.five_hour).toEqual({ pct: 23.5, resets_at: 1_790_000_000_000 });
    expect(u.seven_day).toEqual({ pct: 41, resets_at: 1_790_500_000_000 });
    expect(u.updated_at).toBeGreaterThan(0);
  });

  it('janela ausente mantém a última conhecida', () => {
    const svc = fresh();
    svc.report({ five_hour: { used_percentage: 10, resets_at: 1_790_000_000 }, seven_day: { used_percentage: 5, resets_at: 1_790_500_000 } });
    const u = svc.report({ five_hour: { used_percentage: 12, resets_at: 1_790_000_000 } });
    expect(u.five_hour?.pct).toBe(12);
    expect(u.seven_day?.pct).toBe(5);
  });

  it('guarda em disco e recarrega', () => {
    const dir = mkdtempSync(join(tmpdir(), 'robo-usage-'));
    new ClaudeUsageService({ DATA_DIR: dir } as AppConfig).report({ five_hour: { used_percentage: 77, resets_at: 1_790_000_000 } });
    expect(new ClaudeUsageService({ DATA_DIR: dir } as AppConfig).current.five_hour?.pct).toBe(77);
  });
});
