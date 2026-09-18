import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { AlertService } from '../alerts/alert.service.js';
import { BrainService, type ComposeKind } from '../brain/brain.service.js';
import { ChatService } from '../chat/chat.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import { MemoryService } from '../memory/memory.service.js';
import { RobotStateService } from '../robot/robot-state.service.js';

const TICK_MS = 60_000;
const ATTENTION_PER_DAY = 2;
const ATTENTION_IDLE_H = 3;
const ATTENTION_WINDOW = { from: 10, to: 20 }; // horas locais — nunca de noite
const HOUR = 3600_000;
const QUIET_AFTER_USER_MS = 5 * 60_000;
const THOUGHT_WINDOW = { from: 9, to: 21 };
const THOUGHT_GAP_MIN = { min: 35, span: 40 }; // um pensamento a cada 35–75 min

interface ProactiveMemory {
  morning: string; // último dia (YYYY-MM-DD) em que mandou bom-dia
  evening: string;
  attentionDay: string;
  attentionCount: number;
  lastAttentionAt: number;
  recallDay: string; // último dia em que puxou um assunto antigo
}

const LEARN_GAP_MS = 90 * 60_000; // aprende assuntos no máximo a cada 1h30

/** O robô puxando assunto: bom-dia, resumo do fim do dia, lembretes e pedidos de atenção. */
@Injectable()
export class ProactiveService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ProactiveService.name);
  private readonly file: string;
  private readonly clock: Intl.DateTimeFormat;
  private timer?: NodeJS.Timeout;
  private sub?: Subscription;
  private busy = false;
  private nextThoughtAt = Date.now() + 5 * 60_000;
  private lastLearnAt = 0;
  private mem: ProactiveMemory = { morning: '', evening: '', attentionDay: '', attentionCount: 0, lastAttentionAt: 0, recallDay: '' };

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly chat: ChatService,
    private readonly brain: BrainService,
    private readonly alerts: AlertService,
    private readonly robot: RobotStateService,
    private readonly memory: MemoryService,
  ) {
    this.file = rootPath(`${cfg.DATA_DIR}/proactive.json`);
    this.clock = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: cfg.TZ_NAME,
    });
  }

  onModuleInit(): void {
    try {
      this.mem = { ...this.mem, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ProactiveMemory>) };
    } catch {
      /* primeira vez */
    }
    if (!this.cfg.PROACTIVE) {
      this.log.log('Mensagens proativas desligadas (PROACTIVE=false)');
      return;
    }
    // Lembrete de compromisso também vai para o chat (o alerta da tela continua).
    this.sub = this.alerts.alerts$.subscribe((d) => {
      if (d.id.startsWith('test-') || !d.id.endsWith('-pre')) return;
      this.chat.robotSay(`⏰ Daqui a pouco: ${d.title} (${d.sub ?? ''})`, 'worried', 'reminder');
    });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 5_000);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.sub?.unsubscribe();
  }

  /** Força uma mensagem agora (endpoint de debug). */
  async trigger(kind: ComposeKind | 'thought'): Promise<void> {
    if (kind === 'thought') {
      this.nextThoughtAt = 0;
      await this.maybeThink(12 * 60);
      return;
    }
    await this.send(kind);
  }

  private async tick(): Promise<void> {
    if (this.busy || this.chat.state.thinking) return;
    // No meio de uma conversa não se puxa assunto; tenta de novo no próximo minuto.
    if (Date.now() - this.chat.lastUserAt() < QUIET_AFTER_USER_MS) return;

    // De vez em quando, aprende os assuntos importantes da conversa recente (memória de longo prazo).
    if (Date.now() - this.lastLearnAt > LEARN_GAP_MS && this.chat.lastUserAt() > this.lastLearnAt) {
      this.lastLearnAt = Date.now();
      void this.brain.learn(this.chat.history(12));
    }

    const { date, minutes } = this.now();
    const at = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

    if (this.mem.morning !== date && minutes >= at(this.cfg.MORNING_AT) && minutes < 12 * 60) {
      this.mem.morning = date;
      await this.send('morning');
      return;
    }
    if (this.mem.evening !== date && minutes >= at(this.cfg.EVENING_AT) && minutes < 22 * 60) {
      this.mem.evening = date;
      await this.send('evening');
      return;
    }

    // Puxar um assunto antigo: no máximo uma vez por dia, na parte da tarde, quando está quieto.
    const hourNow = Math.floor(minutes / 60);
    if (
      this.mem.recallDay !== date &&
      hourNow >= 11 &&
      hourNow < 20 &&
      this.chat.state.waitingSince === 0 &&
      this.memory.stale(this.cfg.MEMORY_RECALL_DAYS) &&
      Math.random() < 1 / 25
    ) {
      this.mem.recallDay = date;
      await this.sendRecall();
      return;
    }

    if (await this.maybeThink(minutes)) return;

    if (this.mem.attentionDay !== date) {
      this.mem.attentionDay = date;
      this.mem.attentionCount = 0;
    }
    const hour = Math.floor(minutes / 60);
    const idleH = (Date.now() - this.chat.lastActivityAt()) / HOUR;
    const eligible =
      hour >= ATTENTION_WINDOW.from &&
      hour < ATTENTION_WINDOW.to &&
      this.mem.attentionCount < ATTENTION_PER_DAY &&
      this.chat.state.waitingSince === 0 &&
      idleH >= ATTENTION_IDLE_H &&
      Date.now() - this.mem.lastAttentionAt >= ATTENTION_IDLE_H * HOUR;
    // Sorteio a cada minuto: chega em média ~20 min depois de ficar elegível, sem hora marcada.
    if (eligible && Math.random() < 1 / 20) {
      this.mem.attentionCount++;
      this.mem.lastAttentionAt = Date.now();
      await this.send('attention', idleH);
    }
  }

  /** O robô puxa de volta um assunto que faz tempo que não aparece. */
  private async sendRecall(): Promise<void> {
    this.busy = true;
    const started = Date.now();
    try {
      const r = await this.brain.recall(this.chat.history(6));
      if (!r) return;
      if (this.chat.lastUserAt() >= started || this.chat.state.thinking) return;
      this.memory.touch(r.memoryId);
      this.chat.robotSay(r.text, r.face, 'proactive', { expectsReply: true });
      this.log.log(`Puxou assunto antigo: ${r.text}`);
    } finally {
      this.busy = false;
      this.save();
    }
  }

  /** Pensamento em voz alta na tela do robô, de tempos em tempos durante o dia. */
  private async maybeThink(minutes: number): Promise<boolean> {
    const hour = Math.floor(minutes / 60);
    if (!this.robot.online || hour < THOUGHT_WINDOW.from || hour >= THOUGHT_WINDOW.to) return false;
    if (Date.now() < this.nextThoughtAt) return false;
    this.nextThoughtAt = Date.now() + (THOUGHT_GAP_MIN.min + Math.random() * THOUGHT_GAP_MIN.span) * 60_000;
    this.busy = true;
    try {
      const t = await this.brain.thought(this.chat.history(4));
      if (!t || this.chat.state.thinking) return false;
      this.robot.say(t.text, 7000);
      this.chat.react$.next({ face: t.face, ms: 7000 });
      this.log.log(`Pensamento na tela: ${t.text}`);
      return true;
    } finally {
      this.busy = false;
    }
  }

  private async send(kind: ComposeKind, idleH = 0): Promise<void> {
    this.busy = true;
    const started = Date.now();
    try {
      const { text, face } = await this.brain.compose(kind, this.chat.history(10), idleH);
      if (this.chat.lastUserAt() >= started || this.chat.state.thinking) {
        this.log.log(`Mensagem proativa (${kind}) descartada: o dono começou a conversar`);
        return;
      }
      this.chat.robotSay(text, face, 'proactive', { expectsReply: kind !== 'evening' });
      this.log.log(`Mensagem proativa (${kind}): ${text}`);
    } finally {
      this.busy = false;
      this.save();
    }
  }

  private now(): { date: string; minutes: number } {
    const p = Object.fromEntries(this.clock.formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.mem));
    } catch (err) {
      this.log.warn(`Falha ao salvar ${this.file}: ${(err as Error).message}`);
    }
  }
}
