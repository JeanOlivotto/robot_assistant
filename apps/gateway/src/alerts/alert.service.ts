import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import { LIMITS, type Display } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { deviceText } from '../calendar/device-text.js';
import type { Occurrence } from '../calendar/occurrences.js';

const TICK_MS = 15_000;
/** O aviso "agora" vale por 2 min depois do início. */
const NOW_WINDOW_MS = 2 * 60_000;
const PRE_TTL_MS = 2 * 60_000;
const NOW_TTL_MS = 3 * 60_000;

type AlertKind = 'pre' | 'now';

/** Decide quando avisar na tela: `ALERT_LEAD_MIN` antes e na hora de cada compromisso com horário. */
@Injectable()
export class AlertService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AlertService.name);
  private timer?: NodeJS.Timeout;
  /** id do alerta → epoch em que pode ser esquecido */
  private readonly fired = new Map<string, number>();
  private readonly hhmm: Intl.DateTimeFormat;

  readonly alerts$ = new Subject<Display>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly calendar: CalendarService,
  ) {
    this.hhmm = new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: cfg.TZ_NAME,
    });
  }

  onModuleInit(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  tick(now = Date.now()): void {
    for (const [id, until] of this.fired) if (until < now) this.fired.delete(id);

    for (const occ of this.calendar.upcoming(now)) {
      const kind = this.windowFor(occ, now);
      if (!kind) continue;
      const msg = this.build(occ, kind, now);
      if (this.fired.has(msg.id)) continue;
      this.fired.set(msg.id, occ.end.getTime() + 3600_000);
      this.log.log(`Alerta (${kind}): ${occ.title}`);
      this.alerts$.next(msg);
    }
  }

  /** Alerta que vale agora — enviado a um robô que conecta no meio da janela. */
  active(now = Date.now()): Display | null {
    for (const occ of this.calendar.upcoming(now)) {
      const kind = this.windowFor(occ, now);
      if (kind) return this.build(occ, kind, now);
    }
    return null;
  }

  /** Alerta manual para testar a tela sem esperar um compromisso real. */
  test(title: string, inMin: number, ttlSec: number): Display {
    const now = Date.now();
    const at = now + inMin * 60_000;
    const msg: Display = {
      t: 'display',
      ts: now,
      mode: 'alert',
      id: `test-${now.toString(36)}`,
      title: deviceText(title, LIMITS.TITLE_MAX_BYTES, 'Teste'),
      sub: inMin > 0 ? `às ${this.hhmm.format(at)}` : 'agora',
      at,
      ttl_ms: ttlSec * 1000,
    };
    this.alerts$.next(msg);
    return msg;
  }

  private windowFor(occ: Occurrence, now: number): AlertKind | null {
    if (occ.allDay) return null;
    const start = occ.start.getTime();
    const lead = this.cfg.ALERT_LEAD_MIN * 60_000;
    if (now >= start - lead && now < start) return 'pre';
    if (now >= start && now < start + NOW_WINDOW_MS) return 'now';
    return null;
  }

  private build(occ: Occurrence, kind: AlertKind, now: number): Display {
    const start = occ.start.getTime();
    return {
      t: 'display',
      ts: now,
      mode: 'alert',
      id: `${occ.id}-${kind}`,
      title: occ.title,
      sub: kind === 'pre' ? `às ${this.hhmm.format(start)}` : 'agora',
      at: start,
      ttl_ms: kind === 'pre' ? PRE_TTL_MS : NOW_TTL_MS,
    };
  }
}
