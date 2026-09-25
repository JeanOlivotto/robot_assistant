import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BehaviorSubject, Subject } from 'rxjs';
import { LIMITS, type ChatMessage, type ChatVoz, type Face, type MessageVia, type Mode, type Proposal } from '@robo/protocol';
import { BrainService } from '../brain/brain.service.js';
import { BracoService } from '../braco/braco.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { deviceText } from '../calendar/device-text.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { VisionService } from '../vision/vision.service.js';
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

export interface AskOptions {
  /** Só conta como conversa o que veio depois deste instante (o modo chamada começa do zero). */
  since?: number;
  /** A resposta vai ser FALADA: curta, sem emoji, sem botão. */
  spoken?: boolean;
  /** De quem é a voz (mensagem falada), pelo banco de vozes. */
  voz?: ChatVoz;
  /** O aparelho que pediu: a resposta vai marcada para ele (só ele abre balão e fala). */
  origem?: string;
  /** Pediu de um computador (o nome dele): é nele que o Miro age, se não disser outro. */
  maquina?: string;
}

const PROPOSAL_TTL_MS = 30 * 60_000;
/* "modo hacker" por voz ou texto — o robô também alterna sozinho com dois toques no BOOT. */
const HACKER_OFF = /\b(sa[ií]r?|sai|desliga\w*|tira\w*|encerra\w*|volta\w*)\b[^.]{0,20}\bhacker\b/i;
const HACKER_ON = /\bmodo hacker\b/i;
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
  private queue: Promise<unknown> = Promise.resolve();
  private expiryTimer?: NodeJS.Timeout;

  /** Mensagem nova ou atualizada. */
  readonly messages$ = new Subject<ChatMessage>();
  readonly state$ = new BehaviorSubject<ChatState>({ thinking: false, waitingSince: 0, preview: '' });
  /** Expressão momentânea para a tela do robô. */
  readonly react$ = new Subject<Reaction>();
  /** Cada fala nova do robô, com a origem da mensagem que ele respondeu (para decidir o push). */
  readonly said$ = new Subject<{ message: ChatMessage; replyVia?: MessageVia }>();
  /** Modo visual pedido na conversa — o rosto do robô fica vermelho no 'hacker'. */
  readonly mode$ = new Subject<Mode>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly store: ChatStore,
    private readonly brain: BrainService,
    private readonly calendar: CalendarService,
    private readonly braco: BracoService,
    private readonly vision: VisionService,
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
  async say(text: string, via: MessageVia = 'text', opts: AskOptions = {}): Promise<void> {
    await this.ask(text, via, opts);
  }

  /** Como say(), mas devolve a resposta do robô (a voz precisa dela para falar). */
  ask(text: string, via: MessageVia = 'text', opts: AskOptions = {}): Promise<ChatMessage | undefined> {
    return this.enqueue(() => this.handleUserText(text, via, opts));
  }

  /**
   * Foto do app (já guardada em disco): entra na conversa na hora, e a resposta vem depois que o
   * modelo de visão descrever — a descrição fica na mensagem, para o robô lembrar da foto depois.
   */
  sayPhoto(photo: { id: string; w: number; h: number }, image: Buffer, mime: string, caption: string): Promise<ChatMessage | undefined> {
    return this.enqueue(() => this.handlePhoto(photo, image, mime, caption));
  }

  async confirm(proposalId: string, ok: boolean, origem?: string): Promise<void> {
    await this.enqueue(() => this.handleConfirm(proposalId, ok, origem));
  }

  /** O robô fala. `expectsReply` liga a espera (a cara vai mudando se ninguém responder). */
  robotSay(
    text: string,
    face: Face,
    kind: MessageKind,
    opts: { proposal?: Proposal; expectsReply?: boolean; replyVia?: MessageVia; para?: string } = {},
  ): ChatMessage {
    const msg: ChatMessage = {
      id: randomUUID(),
      from: 'robot',
      text,
      ts: Date.now(),
      kind,
      face,
      proposal: opts.proposal,
      ...(opts.para ? { para: opts.para } : {}),
    };
    this.push(msg);
    this.said$.next({ message: msg, replyVia: opts.replyVia });
    this.react$.next({ face, ms: 5000 });
    this.setState({
      // Resposta a quem perguntou de outro aparelho não vira balão na telinha da mesa (só a cara reage).
      preview: opts.para ? this.state.preview : deviceText(text, LIMITS.PREVIEW_MAX_BYTES),
      waitingSince: opts.expectsReply ? msg.ts : this.state.waitingSince,
    });
    return msg;
  }

  /**
   * O dono abriu o app e viu a conversa: ler já é resposta suficiente para o robô parar de fazer
   * cara de "esperando você". Só a proposta em aberto continua esperando — ela precisa do botão.
   */
  seen(): void {
    if (!this.state.waitingSince) return;
    if (this.store.pendingProposals().length) return;
    this.setState({ waitingSince: 0 });
  }

  /**
   * Acorda o robô da mesa. O firmware sai do repouso quando chega uma reação — então falar com
   * ele pelo celular (texto, áudio, ligação) acorda o da mesa também, em vez de ele seguir dormindo.
   */
  acordar(face: Face = 'happy', ms = 1200): void {
    this.react$.next({ face, ms });
  }

  /** Zera a conversa e o que a telinha do robô está mostrando. */
  clearHistory(): number {
    const had = this.store.clear();
    this.setState({ thinking: false, waitingSince: 0, preview: '' });
    return had;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async handleUserText(text: string, via: MessageVia, opts: AskOptions = {}): Promise<ChatMessage | undefined> {
    const wasWaiting = this.state.waitingSince > 0;
    this.push({
      id: randomUUID(),
      from: 'user',
      text,
      ts: Date.now(),
      via: via === 'text' ? undefined : via,
      ...(opts.voz ? { voz: opts.voz } : {}),
    });
    this.acordar(); // alguém falou com ele: o da mesa acorda e presta atenção

    // "sim"/"não" (digitado ou falado) com uma proposta aberta vale como o botão
    const pending = this.store.pendingProposals();
    if (pending.length === 1 && (YES.test(text) || NO.test(text))) {
      return this.handleConfirm(pending[0]!.proposal!.id, YES.test(text), opts.origem);
    }

    // "entra em modo hacker" / "sai do modo hacker": muda a cor do rosto e responde na hora.
    const hacker = HACKER_OFF.test(text) ? false : HACKER_ON.test(text) ? true : null;
    if (hacker !== null) {
      this.mode$.next(hacker ? 'hacker' : 'normal');
      return this.robotSay(hacker ? 'Modo hacker.' : 'Voltando ao normal.', hacker ? 'thinking' : 'neutral', 'reply', {
        replyVia: via,
        para: opts.origem,
      });
    }

    return this.answer(via, opts, wasWaiting);
  }

  private async handlePhoto(
    photo: { id: string; w: number; h: number },
    image: Buffer,
    mime: string,
    caption: string,
  ): Promise<ChatMessage | undefined> {
    const wasWaiting = this.state.waitingSince > 0;
    const msg: ChatMessage = { id: randomUUID(), from: 'user', text: caption, ts: Date.now(), photo };
    this.push(msg);
    this.acordar();
    this.setState({ thinking: true, waitingSince: 0 });

    const desc = await this.vision.describe(image, mime, caption);
    // Guarda o que ele viu junto da foto: é o que entra no histórico dali em diante.
    this.push({ ...msg, photo: { ...photo, desc: desc ?? undefined } });
    if (!desc) this.log.warn('Nenhum modelo de visão descreveu a foto');
    return this.answer('text', {}, wasWaiting);
  }

  /** O cérebro responde ao que está no histórico (a última mensagem é do dono). */
  private async answer(via: MessageVia, opts: AskOptions, wasWaiting: boolean): Promise<ChatMessage | undefined> {
    this.setState({ thinking: true, waitingSince: 0 });
    if (wasWaiting) this.react$.next({ face: 'love', ms: 2000 }); // finalmente respondeu!
    try {
      const reply = await this.brain.reply(this.context(opts.since), { spoken: opts.spoken ?? via === 'siri', maquina: opts.maquina });
      let proposal: Proposal | undefined;
      if (reply.proposal) {
        this.cancelPending('substituída por outra proposta');
        const d = reply.proposal;
        proposal = d.comando
          ? { id: randomUUID(), kind: 'command', title: d.title, comando: d.comando, maquina: d.maquina, status: 'pending' }
          : {
              id: randomUUID(),
              kind: 'event',
              title: d.title,
              start: d.start!.getTime(),
              end: d.end!.getTime(),
              status: 'pending',
            };
      }
      this.setState({ thinking: false });
      return this.robotSay(reply.text, reply.face, 'reply', { proposal, expectsReply: !!proposal, replyVia: via, para: opts.origem });
    } catch (err) {
      this.log.error(`Cérebro falhou: ${(err as Error).message}`);
      this.setState({ thinking: false });
      return this.robotSay('Minha cabeça travou agora. Repete daqui a pouco.', 'sad', 'reply', { replyVia: via, para: opts.origem });
    }
  }

  private async handleConfirm(proposalId: string, ok: boolean, para?: string): Promise<ChatMessage | undefined> {
    const msg = this.store.findByProposal(proposalId);
    const p = msg?.proposal;
    if (!msg || !p || p.status !== 'pending') return undefined;

    if (!ok) {
      this.updateProposal(msg, { status: 'cancelled' });
      this.settleWaiting();
      return this.robotSay(p.kind === 'command' ? 'Certo, não faço.' : 'Certo, não marquei.', 'neutral', 'reply', { para });
    }

    if (p.kind === 'command') return this.runApproved(msg, p, para);

    this.setState({ thinking: true });
    try {
      await this.calendar.createEvent(p.title, new Date(p.start!), new Date(p.end!));
      this.updateProposal(msg, { status: 'confirmed' });
      this.setState({ thinking: false });
      this.settleWaiting();
      return this.robotSay(`Marcado: ${p.title}, ${this.timeFmt.format(p.start!)}.`, 'happy', 'reply', { para });
    } catch (err) {
      const error = (err as Error).message;
      this.log.error(`Falha ao criar evento: ${error}`);
      this.updateProposal(msg, { status: 'failed', error });
      this.setState({ thinking: false });
      this.settleWaiting();
      return this.robotSay(`Não consegui marcar: ${error}`, 'sad', 'reply', { para });
    }
  }

  /**
   * O que o cérebro enxerga da conversa. Com `since` (uma chamada de voz), só o que foi dito
   * depois que a chamada abriu — o robô começa do zero, mas continua lembrando pela memória longa.
   */
  private context(since?: number): ChatMessage[] {
    const all = this.store.recent(40);
    if (!since) return all;
    const fresh = all.filter((m) => m.ts >= since);
    return fresh.length ? fresh : all.slice(-1);
  }

  /**
   * O dono aprovou no botão: aí sim o comando sai daqui para a máquina dele, e a saída
   * volta no chat. Sem esse "sim" nada roda — é o que separa um assistente de uma porta aberta.
   */
  private async runApproved(msg: ChatMessage, p: Proposal, para?: string): Promise<ChatMessage | undefined> {
    this.setState({ thinking: true });
    const r = await this.braco.rodarComando(p.comando ?? '', p.maquina);
    this.setState({ thinking: false });
    this.updateProposal(msg, { status: r.ok ? 'confirmed' : 'failed', error: r.erro });
    this.settleWaiting();
    this.log.log(`Comando aprovado (${r.ok ? 'ok' : 'falhou'}): ${p.comando}`);

    if (!r.ok) return this.robotSay(`Não rolou: ${r.erro ?? 'a máquina recusou'}`, 'sad', 'reply', { para });
    const saida = r.saida.trim();
    const curta = saida.length > 400 ? `${saida.slice(0, 400)}…` : saida;
    return this.robotSay(curta ? `Feito.\n\n${curta}` : 'Feito.', 'happy', 'reply', { para });
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
