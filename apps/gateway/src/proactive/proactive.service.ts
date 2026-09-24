import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { AlertService } from '../alerts/alert.service.js';
import { BrainService, type ComposeKind } from '../brain/brain.service.js';
import { ChatService } from '../chat/chat.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import { RobotStateService } from '../robot/robot-state.service.js';
import { TaskService } from '../tasks/task.service.js';

const TICK_MS = 60_000;
const HOUR = 3600_000;

/* Os limites que o robô NÃO decide: ele julga se vale falar, dentro desta cerca. */
const AWAKE_WINDOW = { from: 7, to: 22 }; // horas locais — fora disso, nem pergunta
/* Sem teto por dia: quantas vezes ele fala é decisão dele. O intervalo só evita rajada. */
const SPEAK_GAP_MS = 20 * 60_000; // intervalo mínimo entre duas falas espontâneas
const JUDGE_GAP_MS = 20 * 60_000; // de quanto em quanto tempo ele para e pensa se vale falar
const QUIET_AFTER_USER_MS = 5 * 60_000;
const THOUGHT_WINDOW = { from: 9, to: 21 };
const THOUGHT_GAP_MIN = { min: 35, span: 40 }; // um pensamento a cada 35–75 min

interface ProactiveMemory {
  /** Dia (YYYY-MM-DD) a que se refere a contagem abaixo. */
  day: string;
  /** Quantas vezes ele puxou conversa hoje. */
  spokenCount: number;
  lastSpokenAt: number;
  /** A última fala espontânea — entra no juízo para ele não se repetir. */
  lastSpokenText: string;
  lastJudgeAt: number;
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
  private mem: ProactiveMemory = { day: '', spokenCount: 0, lastSpokenAt: 0, lastSpokenText: '', lastJudgeAt: 0 };

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly chat: ChatService,
    private readonly brain: BrainService,
    private readonly alerts: AlertService,
    private readonly robot: RobotStateService,
    private readonly tasks: TaskService,
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

    if (await this.maybeThink(this.now().minutes)) return;
    await this.maybeSpeak();
  }

  /**
   * A parte que ele NÃO decide: hora e intervalo. Passando na cerca, quem decide
   * se vale falar (e o que dizer) é ele, em brain.judge().
   */
  private async maybeSpeak(): Promise<void> {
    const { date, minutes } = this.now();
    if (this.mem.day !== date) {
      this.mem.day = date;
      this.mem.spokenCount = 0;
    }

    const hour = Math.floor(minutes / 60);
    const now = Date.now();
    if (hour < AWAKE_WINDOW.from || hour >= AWAKE_WINDOW.to) return; // de madrugada, nem pergunta
    if (now - this.mem.lastSpokenAt < SPEAK_GAP_MS) return;
    if (now - this.mem.lastJudgeAt < JUDGE_GAP_MS) return;

    this.mem.lastJudgeAt = now;
    this.busy = true;
    const started = now;
    try {
      const lastUser = this.chat.lastUserAt();
      // Só entram as que ele não cobrou nas últimas 20 h — senão vira cobrança diária da mesma coisa.
      const pendentes = this.tasks.worthNudging(20).slice(0, 5);
      // A conversa do dia inteiro, não só as últimas: ele perguntava "como foi a ligação?" de
      // algo que o dono tinha contado de manhã, 10 mensagens antes.
      const today = this.chat.history(60).filter((m) => this.sameDay(m.ts, now));
      const call = await this.brain.judge(today.length ? today : this.chat.history(6), {
        idleHours: (now - this.chat.lastActivityAt()) / HOUR,
        lastSpontaneous: this.mem.lastSpokenText,
        spokenToday: this.mem.spokenCount,
        talkedToday: lastUser > 0 && this.sameDay(lastUser, now),
        // Não espera resposta para voltar a falar: só avisa o juízo, para ele não insistir no mesmo assunto.
        unanswered: this.chat.state.waitingSince !== 0,
        pending: pendentes.map((t) => ({
          texto: t.texto,
          pessoa: t.pessoa,
          diasAberta: Math.floor((now - t.createdAt) / (24 * HOUR)),
        })),
      });
      if (!call) return;
      if (!call.speak) {
        this.log.debug(`Ficou quieto: ${call.reason}`);
        return;
      }
      // Ele demorou pensando e o dono falou nesse meio tempo: a fala perdeu a hora.
      if (this.chat.lastUserAt() >= started || this.chat.state.thinking) return;

      this.mem.spokenCount += 1;
      this.mem.lastSpokenAt = Date.now();
      this.mem.lastSpokenText = call.text;
      this.chat.robotSay(call.text, call.face, 'proactive', { expectsReply: true });
      // As pendências que ele citou ficam em carência, para não cobrar a mesma amanhã de novo.
      if (call.nudged.length) this.tasks.nudged(call.nudged.map((n) => pendentes[n - 1]!.id).filter(Boolean));
      this.log.log(`Puxou conversa (${this.mem.spokenCount}ª hoje): ${call.text} — ${call.reason}`);
    } finally {
      this.busy = false;
      this.save();
    }
  }

  private sameDay(a: number, b: number): boolean {
    return this.clock.format(a).slice(0, 10) === this.clock.format(b).slice(0, 10);
  }

  /** Pensamento em voz alta no balão da telinha — não vai para o chat. */
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
