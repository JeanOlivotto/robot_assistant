import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

/** Uma janela como o Claude Code manda em `rate_limits` (resets_at em segundos). */
const RateWindow = z.object({
  used_percentage: z.number().min(0),
  resets_at: z.number().nonnegative(),
});

/** Corpo do POST: o próprio `rate_limits` da barra de status, embrulhado ou não. */
export const UsageReport = z.union([
  z.object({ rate_limits: z.object({ five_hour: RateWindow.optional(), seven_day: RateWindow.optional() }) }),
  z.object({ five_hour: RateWindow.optional(), seven_day: RateWindow.optional() }),
]);
export type UsageReport = z.infer<typeof UsageReport>;

/** Uma janela do plano: % usado (passa de 100 em limite de gasto) e quando renova. */
export interface UsageWindow {
  pct: number;
  resets_at: number;
}

/** O uso do Claude do dono. Vive só no servidor: alimenta os avisos, não vai mais para o robô. */
export interface UsageSnapshot {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  /** Quando o Claude Code mandou esses números pela última vez (0 = nunca). */
  updated_at: number;
}

const EMPTY: UsageSnapshot = { five_hour: null, seven_day: null, updated_at: 0 };

function window(w: z.infer<typeof RateWindow> | undefined): UsageSnapshot['five_hour'] {
  if (!w) return null;
  // O Claude Code manda epoch em segundos; aceita milissegundos também, por garantia.
  const resetsAt = w.resets_at < 1e12 ? Math.round(w.resets_at * 1000) : Math.round(w.resets_at);
  return { pct: Math.min(1000, Math.round(w.used_percentage * 10) / 10), resets_at: resetsAt };
}

/**
 * Uso do plano Claude do dono. Quem alimenta é a barra de status do Claude Code
 * (tools/claude-usage), que posta aqui; o robô mostra no KEY2.
 */
@Injectable()
export class ClaudeUsageService {
  private readonly log = new Logger(ClaudeUsageService.name);
  private readonly file: string;
  readonly usage$: BehaviorSubject<UsageSnapshot>;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/claude-usage.json`);
    let saved = EMPTY;
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8')) as UsageSnapshot;
    } catch {
      /* nada recebido ainda */
    }
    this.usage$ = new BehaviorSubject(saved);
  }

  get current(): UsageSnapshot {
    return this.usage$.value;
  }

  report(body: UsageReport): UsageSnapshot {
    const limits = 'rate_limits' in body ? body.rate_limits : body;
    const prev = this.current;
    const next: UsageSnapshot = {
      // Janela ausente = o Claude Code ainda não soube dela nesta sessão; mantém a última conhecida.
      five_hour: window(limits.five_hour) ?? prev.five_hour,
      seven_day: window(limits.seven_day) ?? prev.seven_day,
      updated_at: Date.now(),
    };
    if (next.five_hour?.pct !== prev.five_hour?.pct || next.seven_day?.pct !== prev.seven_day?.pct) {
      this.log.log(`Uso do Claude: 5h ${next.five_hour?.pct ?? '-'}%, semana ${next.seven_day?.pct ?? '-'}%`);
    }
    this.usage$.next(next);
    this.save(next);
    return next;
  }

  private save(usage: UsageSnapshot): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(usage));
    } catch (err) {
      this.log.error(`Falha ao salvar uso do Claude: ${(err as Error).message}`);
    }
  }
}
