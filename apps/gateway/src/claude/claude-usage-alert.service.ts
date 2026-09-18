import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import { PushService } from '../push/push.service.js';
import { RobotStateService } from '../robot/robot-state.service.js';
import { ClaudeUsageService, type UsageSnapshot } from './claude-usage.service.js';

type Window = 'five_hour' | 'seven_day';
const LABELS: Record<Window, string> = { five_hour: 'sessão de 5h', seven_day: 'uso semanal' };

/** O que já foi avisado de cada janela — para não repetir e para saber quando renovou. */
interface WinMemory {
  resetsAt: number;
  level: number; // maior % já avisado nesta janela
}
type Memory = Record<Window, WinMemory>;

const EMPTY: Memory = { five_hour: { resetsAt: 0, level: 0 }, seven_day: { resetsAt: 0, level: 0 } };

/**
 * Avisa sobre o uso do Claude: quando cruza um % (50/80/95…) e quando a janela renova.
 * Vai para o celular (push) e para o balão na tela do robô. Não repete o mesmo aviso.
 */
@Injectable()
export class ClaudeUsageAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ClaudeUsageAlertService.name);
  private readonly file: string;
  private readonly percents: number[];
  private mem: Memory = structuredClone(EMPTY);
  private sub?: Subscription;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly usage: ClaudeUsageService,
    private readonly push: PushService,
    private readonly robot: RobotStateService,
  ) {
    this.file = rootPath(`${cfg.DATA_DIR}/claude-usage-alerts.json`);
    this.percents = cfg.CLAUDE_ALERT_PERCENTS;
  }

  onModuleInit(): void {
    try {
      this.mem = { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(this.file, 'utf8')) as Memory) };
    } catch {
      /* primeira vez */
    }
    if (!this.percents.length) {
      this.log.log('CLAUDE_ALERT_PERCENTS vazio — avisos de uso desligados');
      return;
    }
    this.sub = this.usage.usage$.subscribe((u) => this.onUsage(u));
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  private onUsage(u: UsageSnapshot): void {
    if (!u.updated_at) return; // ainda sem dados reais
    this.check('five_hour', u.five_hour);
    this.check('seven_day', u.seven_day);
  }

  private check(win: Window, w: UsageSnapshot['five_hour']): void {
    if (!w) return;
    const mem = this.mem[win];

    // Janela nova (resets_at mudou): zera o que foi avisado e avisa que renovou.
    if (mem.resetsAt && Math.abs(w.resets_at - mem.resetsAt) > 60_000) {
      const hadAlert = mem.level > 0;
      mem.resetsAt = w.resets_at;
      mem.level = 0;
      this.save();
      if (hadAlert) this.announceReset(win);
    } else if (!mem.resetsAt) {
      mem.resetsAt = w.resets_at; // primeira leitura desta janela: só registra
    }

    const crossed = this.percents.filter((p) => w.pct >= p && p > mem.level).pop();
    if (crossed === undefined) return;
    mem.level = crossed;
    this.save();
    this.announceThreshold(win, crossed, w.resets_at);
  }

  private announceThreshold(win: Window, pct: number, resetsAt: number): void {
    const when = this.formatReset(win, resetsAt);
    const body = `${cap(LABELS[win])} em ${pct}%${when ? ` — renova ${when}` : ''}.`;
    this.log.log(`Aviso de uso: ${body}`);
    void this.push.notify({ title: 'Uso do Claude', body, tag: `claude-${win}`, url: '/' });
    this.robot.say(win === 'five_hour' ? `Sessao 5h em ${pct}%` : `Uso semanal em ${pct}%`);
  }

  private announceReset(win: Window): void {
    const body =
      win === 'five_hour'
        ? 'Sessão de 5h renovada — 100% disponível de novo.'
        : 'Uso semanal renovado — limite cheio de novo.';
    this.log.log(`Aviso de uso: ${body}`);
    void this.push.notify({ title: 'Uso do Claude', body, tag: `claude-${win}`, url: '/' });
    this.robot.say(win === 'five_hour' ? 'Sessao 5h renovada!' : 'Semana renovada!');
  }

  /** Renovação da sessão 5h: só a hora. Semanal: dia da semana + hora. */
  private formatReset(win: Window, resetsAt: number): string {
    if (!resetsAt) return '';
    const opts: Intl.DateTimeFormatOptions =
      win === 'seven_day'
        ? { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: this.cfg.TZ_NAME }
        : { hour: '2-digit', minute: '2-digit', timeZone: this.cfg.TZ_NAME };
    return new Intl.DateTimeFormat('pt-BR', opts).format(new Date(resetsAt)).replace('.', '');
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.mem));
    } catch (err) {
      this.log.error(`Falha ao salvar avisos de uso: ${(err as Error).message}`);
    }
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
