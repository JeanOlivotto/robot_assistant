import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import ical, { type CalendarResponse } from 'node-ical';
import { BehaviorSubject } from 'rxjs';
import type { AgendaItem } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import { GoogleCalendarClient } from './google-calendar.client.js';
import { expandCalendar, toAgendaItems, type Occurrence } from './occurrences.js';

const LOOKBACK_MS = 12 * 3600_000;
/** Janela mantida em memória: cobre "esta semana" para o cérebro e o webapp. */
const WINDOW_MS = 8 * 24 * 3600_000;
const APP_AGENDA_MAX = 50;

export type CalendarSource = 'google' | 'ical' | 'none';

export interface CalendarStatus {
  source: CalendarSource;
  writable: boolean;
  serviceAccount: string | null;
  lastFetchAt: string | null;
  lastError: string | null;
  occurrences: number;
}

/**
 * Agenda do dono. Fonte: Google Calendar API com conta de serviço (lê e escreve)
 * ou, na falta dela, o link iCal secreto (só leitura).
 */
@Injectable()
export class CalendarService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CalendarService.name);
  private readonly google: GoogleCalendarClient | null = null;
  private timer?: NodeJS.Timeout;
  private occurrences: Occurrence[] = [];
  private icalCache: CalendarResponse | null = null;
  private refreshing: Promise<void> | null = null;

  /** Próximas horas, no limite do firmware. Só emite quando muda. */
  readonly agenda$ = new BehaviorSubject<AgendaItem[]>([]);
  /** Próximos 8 dias, para o webapp. */
  readonly appAgenda$ = new BehaviorSubject<AgendaItem[]>([]);

  readonly status: CalendarStatus;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    let source: CalendarSource = 'none';
    if (cfg.GOOGLE_SA_KEY_FILE && cfg.GCAL_ID) {
      const keyFile = rootPath(cfg.GOOGLE_SA_KEY_FILE);
      try {
        this.google = new GoogleCalendarClient(keyFile, cfg.GCAL_ID, cfg.TZ_NAME);
        source = 'google';
      } catch (err) {
        this.log.error(`Não consegui ler a conta de serviço em ${keyFile}: ${(err as Error).message}`);
      }
    }
    if (source === 'none' && cfg.GCAL_ICS_URL) source = 'ical';

    this.status = {
      source,
      writable: source === 'google',
      serviceAccount: this.google?.serviceAccount ?? null,
      lastFetchAt: null,
      lastError: null,
      occurrences: 0,
    };
  }

  get writable(): boolean {
    return this.status.writable;
  }

  onModuleInit(): void {
    const { source } = this.status;
    if (source === 'none') {
      this.log.warn('Nenhuma agenda configurada (GOOGLE_SA_KEY_FILE + GCAL_ID, ou GCAL_ICS_URL)');
      return;
    }
    this.log.log(
      source === 'google'
        ? `Agenda: Google Calendar API (${this.cfg.GCAL_ID}) — leitura e escrita`
        : 'Agenda: link iCal — só leitura (sem conta de serviço, o robô não cria eventos)',
    );
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.cfg.CALENDAR_POLL_SEC * 1000);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Relê a agenda. Chamadas concorrentes esperam a mesma leitura. */
  refresh(): Promise<void> {
    if (this.status.source === 'none') return Promise.resolve();
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const now = Date.now();
    try {
      this.occurrences = await this.fetch(new Date(now - LOOKBACK_MS), new Date(now + WINDOW_MS), true);
      this.status.lastFetchAt = new Date(now).toISOString();
      this.status.lastError = null;
      this.status.occurrences = this.occurrences.length;
      this.publish(now);
    } catch (err) {
      this.status.lastError = describeError(err);
      this.log.error(`Falha ao ler a agenda: ${this.status.lastError}`);
    }
  }

  private async fetch(from: Date, to: Date, reload: boolean): Promise<Occurrence[]> {
    if (this.google) return this.google.list(from, to);
    if (reload || !this.icalCache) {
      const res = await fetch(this.cfg.GCAL_ICS_URL, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar o iCal`);
      this.icalCache = await ical.async.parseICS(await res.text());
    }
    return expandCalendar(this.icalCache, from, to);
  }

  /** Ocorrências que ainda não terminaram (da janela em memória). */
  upcoming(now = Date.now()): Occurrence[] {
    return this.occurrences.filter((o) => o.end.getTime() > now);
  }

  /** Qualquer intervalo — usa a memória quando cabe, senão busca na fonte. */
  async query(from: Date, to: Date): Promise<Occurrence[]> {
    if (this.status.source === 'none') return [];
    const now = Date.now();
    const inWindow = from.getTime() >= now - LOOKBACK_MS && to.getTime() <= now + WINDOW_MS;
    const list = inWindow && this.status.lastFetchAt ? this.occurrences : await this.fetch(from, to, false);
    return list.filter((o) => o.end > from && o.start < to);
  }

  async createEvent(title: string, start: Date, end: Date): Promise<void> {
    if (!this.google) throw new Error('agenda sem permissão de escrita (falta a conta de serviço)');
    try {
      await this.google.insert(title, start, end);
    } catch (err) {
      throw new Error(describeError(err));
    }
    this.log.log(`Evento criado: ${title} (${start.toISOString()})`);
    await this.refresh();
  }

  private publish(now: number): void {
    const upcoming = this.upcoming(now);
    const horizon = now + this.cfg.AGENDA_HORIZON_H * 3600_000;
    const device = toAgendaItems(upcoming.filter((o) => o.start.getTime() < horizon));
    if (JSON.stringify(device) !== JSON.stringify(this.agenda$.value)) {
      this.log.log(`Agenda: ${device.length} compromisso(s) nas próximas ${this.cfg.AGENDA_HORIZON_H}h`);
      this.agenda$.next(device);
    }
    const app = toAgendaItems(upcoming, APP_AGENDA_MAX);
    if (JSON.stringify(app) !== JSON.stringify(this.appAgenda$.value)) this.appAgenda$.next(app);
  }
}

/** Mensagens de erro do Google que ajudam a configurar. */
function describeError(err: unknown): string {
  const status = (err as { status?: number; response?: { status?: number } })?.response?.status ??
    (err as { status?: number })?.status;
  if (status === 404) return 'agenda não encontrada — ela foi compartilhada com a conta de serviço? (GCAL_ID certo?)';
  if (status === 403) return 'sem permissão — compartilhe a agenda com a conta de serviço como "Fazer alterações nos eventos"';
  return err instanceof Error ? err.message : String(err);
}
