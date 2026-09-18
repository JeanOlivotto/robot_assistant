import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BehaviorSubject, Subject } from 'rxjs';
import { LIMITS, type ChatMessage, type Face, type Proposal } from '@robo/protocol';
import { BrainService } from '../brain/brain.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { deviceText } from '../calendar/device-text.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { ChatStore } from './chat.store.js';

export interface ChatState {
  thinking: boolean;
  /** Desde quando o robô espera resposta do dono (0 = não espera). */
  waitingSince: number;
  /** Trecho da última fala do robô, para o rodapé da tela. */
  preview: string;
}

export interface Reaction {
  face: Face;
  ms: number;
}

type MessageKind = NonNullable<ChatMessage['kind']>;

const PROPOSAL_TTL_MS = 30 * 60_000;
const YES = /^(sim|s|pode|pode sim|confirma|confirmado|confirmo|ok|isso|bora|claro|manda ver)[\s!.]*$/i;
const NO = /^(n[aã]o|cancela|cancelar|deixa|esquece|deixa pra l[aá])[\s!.]*$/i;

/**
 * A conversa com o dono: mensagens em ordem, propostas que só viram evento com o "sim",
 * e o estado que vira expressão na tela (pensando, esperando resposta).
 */
@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ChatService.name);
  private readonly timeFmt: Intl.DateTimeFormat;
  private queue: Promise<void> = Promise.resolve();
  private expiryTimer?: NodeJS.Timeout;

  /** Mensagem nova ou atualizada. */
  readonly messages$ = new Subject<ChatMessage>();
  readonly state$ = new BehaviorSubject<ChatState>({ thinking: false, waitingSince: 0, preview: '' });
  /** Expressão momentânea para a tela do robô. */
  readonly react$ = new Subject<Reaction>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly store: ChatStore,
    private readonly brain: BrainService,
    private readonly calendar: CalendarService,
  ) {
    this.timeFmt = new Intl.DateTimeFormat('pt-BR', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: cfg.TZ_NAME,
    });
  }

  onModuleInit(): void {
    // Retoma o estado de antes de reiniciar: está esperando resposta se a última fala foi do robô e pedia resposta.
    const history = this.store.recent(50);
    const lastRobot = [...history].reverse().find((m) => m.from === 'robot');
    const lastUser = [...history].reverse().find((m) => m.from === 'user');
    const waiting =
      lastRobot && (!lastUser || lastRobot.ts > lastUser.ts) && (lastRobot.kind === 'proactive' || lastRobot.proposal?.status === 'pending');
    this.setState({
      preview: lastRobot ? deviceText(lastRobot.text, LIMITS.PREVIEW_MAX_BYTES) : '',
      waitingSince: waiting ? lastRobot.ts : 0,
    });
    this.expiryTimer = setInterval(() => this.expireProposals(), 60_000);
  }

  onModuleDestroy(): void {
    clearInterval(this.expiryTimer);
  }

  get state(): ChatState {
    return this.state$.value;
  }

  history(n = 100): ChatMessage[] {
    return this.store.recent(n);
  }

  /** Última atividade de qualquer lado (para o robô saber se está sendo ignorado). */
  lastActivityAt(): number {
    return this.store.recent(1)[0]?.ts ?? 0;
  }

  lastUserAt(): number {
    return this.store.recent(50).findLast((m) => m.from === 'user')?.ts ?? 0;
  }

  /** Mensagem do dono. Processadas uma de cada vez, na ordem. */
  say(text: string): Promise<void> {
    return this.enqueue(() => this.handleUserText(text));
  }

  confirm(proposalId: string, ok: boolean): Promise<void> {
    return this.enqueue(() => this.handleConfirm(proposalId, ok));
  }

  /** O robô fala. `expectsReply` liga a espera (a cara vai mudando se ninguém responder). */
  robotSay(text: string, face: Face, kind: MessageKind, opts: { proposal?: Proposal; expectsReply?: boolean } = {}): ChatMessage {
    const msg: ChatMessage = { id: randomUUID(), from: 'robot', text, ts: Date.now(), kind, face, proposal: opts.proposal };
    this.push(msg);
    this.react$.next({ face, ms: 5000 });
    this.setState({
      preview: deviceText(text, LIMITS.PREVIEW_MAX_BYTES),
      waitingSince: opts.expectsReply ? msg.ts : this.state.waitingSince,
    });
    return msg;
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async handleUserText(text: string): Promise<void> {
    const wasWaiting = this.state.waitingSince > 0;
    this.push({ id: randomUUID(), from: 'user', text, ts: Date.now() });

    // "sim"/"não" digitado com uma proposta aberta vale como o botão
    const pending = this.store.pendingProposals();
    if (pending.length === 1 && (YES.test(text) || NO.test(text))) {
      await this.handleConfirm(pending[0]!.proposal!.id, YES.test(text));
      return;
    }

    this.setState({ thinking: true, waitingSince: 0 });
    if (wasWaiting) this.react$.next({ face: 'love', ms: 2000 }); // finalmente respondeu!
    try {
      const reply = await this.brain.reply(this.store.recent(40));
      let proposal: Proposal | undefined;
      if (reply.proposal) {
        this.cancelPending('substituída por outra proposta');
        proposal = {
          id: randomUUID(),
          kind: 'event',
          title: reply.proposal.title,
          start: reply.proposal.start.getTime(),
          end: reply.proposal.end.getTime(),
          status: 'pending',
        };
      }
      this.setState({ thinking: false });
      this.robotSay(reply.text, reply.face, 'reply', { proposal, expectsReply: !!proposal });
    } catch (err) {
      this.log.error(`Cérebro falhou: ${(err as Error).message}`);
      this.setState({ thinking: false });
      this.robotSay('Ops, minha cabeça deu um nó... tenta de novo daqui a pouco?', 'sad', 'reply');
    }
  }

  private async handleConfirm(proposalId: string, ok: boolean): Promise<void> {
    const msg = this.store.findByProposal(proposalId);
    const p = msg?.proposal;
    if (!msg || !p || p.status !== 'pending') return;

    if (!ok) {
      this.updateProposal(msg, { status: 'cancelled' });
      this.settleWaiting();
      this.robotSay('Beleza, não marquei.', 'neutral', 'reply');
      return;
    }

    this.setState({ thinking: true });
    try {
      await this.calendar.createEvent(p.title, new Date(p.start), new Date(p.end));
      this.updateProposal(msg, { status: 'confirmed' });
      this.setState({ thinking: false });
      this.settleWaiting();
      this.robotSay(`Marcado! ✅ ${p.title}, ${this.timeFmt.format(p.start)}.`, 'happy', 'reply');
    } catch (err) {
      const error = (err as Error).message;
      this.log.error(`Falha ao criar evento: ${error}`);
      this.updateProposal(msg, { status: 'failed', error });
      this.setState({ thinking: false });
      this.settleWaiting();
      this.robotSay(`Não consegui marcar: ${error}`, 'sad', 'reply');
    }
  }

  private cancelPending(reason: string): void {
    for (const m of this.store.pendingProposals()) this.updateProposal(m, { status: 'cancelled', error: reason });
  }

  private expireProposals(): void {
    const now = Date.now();
    let changed = false;
    for (const m of this.store.pendingProposals()) {
      if (now - m.ts > PROPOSAL_TTL_MS) {
        this.updateProposal(m, { status: 'expired' });
        changed = true;
      }
    }
    if (changed) this.settleWaiting();
  }

  /** Sem proposta aberta, o robô para de esperar. */
  private settleWaiting(): void {
    if (!this.store.pendingProposals().length) this.setState({ waitingSince: 0 });
  }

  private updateProposal(msg: ChatMessage, patch: Partial<Proposal>): void {
    this.push({ ...msg, proposal: { ...msg.proposal!, ...patch } });
  }

  private push(msg: ChatMessage): void {
    this.store.upsert(msg);
    this.messages$.next(msg);
  }

  private setState(patch: Partial<ChatState>): void {
    this.state$.next({ ...this.state$.value, ...patch });
  }
}
