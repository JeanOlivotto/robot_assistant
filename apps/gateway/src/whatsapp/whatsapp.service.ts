import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isPnUser,
  useMultiFileAuthState,
  type Contact,
  type WACallEvent,
  type WAMessage,
} from 'baileys';
import QRCode from 'qrcode';
import { Subject } from 'rxjs';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import { MAX_VOICE_SECONDS, SttService } from '../stt/stt.service.js';
import { TtsService } from '../tts/tts.service.js';
import { VisionService } from '../vision/vision.service.js';
import { figurinha } from './figurinha.js';
import { acharPorNome, aplicarMencoes, arroba, comAPalavra, conteudo, corpo, descrever, naoENome, type Recebida, semAcento } from './mensagem.js';
import { digitosDe, jidDoNumero, type Lembranca, numeroBate, porAssunto } from './procurar.js';
import type { Face } from '@robo/protocol';

type Socket = ReturnType<typeof makeWASocket>;

export type EstadoWhatsapp = 'desligado' | 'aguardando_qr' | 'conectando' | 'conectado';

/** Só as últimas, e só por um tempo: é para "chegou uma mensagem agora, vê pra mim", não um arquivo. */
const MAX_RECEBIDAS = 60;
const GUARDA_MS = 12 * 3600_000;
/** Só o texto (sem mídia) fica mais tempo: é por ele que o dono acha o cliente pelo assunto. */
const HISTORICO_MS = 7 * 24 * 3600_000;
const MAX_HISTORICO = 3000;
/** Contatos da agenda chegam do celular numa sincronização à parte; sem eles, tenta de novo nestes tempos. */
const RESYNC_MS = [5_000, 30_000, 120_000];
/** "Acabei de receber uma mensagem": a pessoa manda em pedaços, então vêm juntas as desse intervalo. */
const RAJADA_MS = 10 * 60_000;
const MAX_RAJADA = 8;

interface Combinado {
  /** O dono pareou e quer o robô conectado (desconectar pelo app volta para false). */
  ativo: boolean;
  /** Privacidade: não olha nada até este instante. 0 = desligada; -1 = até ele pedir para voltar. */
  privadoAte: number;
  /** Quem chama o robô pelo nome numa conversa privada pode conversar com ele (só conversar). */
  atender: boolean;
  /** Grupos (jid) onde ele tira dúvida de código lendo os projetos do dono — em palavras, sem colar código. */
  gruposTecnicos: string[];
  /** O dono pediu para o robô responder estes contatos no lugar dele, até `ate` (-1 = até ele pedir para parar). */
  cobrir: Cobertura | null;
}

/** "Responde o Fábio e a Jaque por mim até as 6": só conversas privadas. */
interface Cobertura {
  ate: number;
  contatos: { id: string; nome: string }[];
  /** Todo mundo no privado, não só a lista. */
  todos?: boolean;
  /** Com `todos`: estes ficam de fora ("todo mundo menos a Duda"). */
  exceto?: { id: string; nome: string }[];
}

/** Uma conversa para onde dá para mandar: contato ou grupo. */
interface Destino {
  id: string;
  nome: string;
  grupo: boolean;
}

/** Baileys fala muito; aqui só o que é erro de verdade, e em debug. */
function loggerQuieto(log: Logger) {
  const nada = () => undefined;
  const l = {
    level: 'error',
    child: () => l,
    trace: nada,
    debug: nada,
    info: nada,
    warn: nada,
    error: (obj: unknown, msg?: string) => log.debug(`baileys: ${msg ?? ''} ${obj instanceof Error ? obj.message : ''}`.trim()),
  };
  return l;
}

/**
 * O WhatsApp do dono, pelo Baileys (entra como um "aparelho conectado", igual ao WhatsApp Web).
 *
 * Três regras que não podem quebrar:
 *  - As notificações do celular continuam: a conexão nunca fica "online" (markOnlineOnConnect:
 *    false, recibo "inactive") e nada é marcado como lido — nenhum tique azul sai daqui.
 *  - Ele só LÊ quando o dono pede. As mensagens ficam numa lista curta (12 h, últimas 60 — em disco
 *    no servidor, para sobreviver a deploy; nada vai para o LLM) até o dono dizer "vê essa mensagem pra mim".
 *  - Ele só MANDA com o "sim" do dono, numa proposta que mostra o destino e o texto.
 *
 * Privacidade: com ela ligada, o que chega é descartado na hora e a lista é apagada.
 */
/** Uma ligação do WhatsApp: quem liga, e se está chegando ou acabou (recusada, perdida, desligada). */
export interface Ligacao {
  id: string;
  nome: string;
  grupo: boolean;
  video: boolean;
  fase: 'chegando' | 'acabou';
}

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WhatsappService.name);
  private readonly authDir: string;
  private readonly file: string;
  private readonly contatosFile: string;
  /** As mensagens recentes (12 h, últimas 60): sem isto, cada deploy/restart apagava o que tinha chegado. */
  private readonly recebidasFile: string;
  private salvarRecebidas: NodeJS.Timeout | null = null;
  /** O texto das mensagens dos últimos 7 dias (sem mídia) — para achar a conversa pelo assunto. */
  private readonly historicoFile: string;
  private salvarHistorico: NodeJS.Timeout | null = null;
  private historico: Lembranca[] = [];
  /** Apelido que o dono deu a uma conversa (jid → "cliente da padaria"): cliente fora da agenda, sem nome lembrado. */
  private apelidos = new Map<string, string>();
  private salvarContatos: NodeJS.Timeout | null = null;
  private c: Combinado = { ativo: false, privadoAte: 0, atender: true, gruposTecnicos: [], cobrir: null };

  private sock: Socket | null = null;
  private tentativas = 0;
  private religar: NodeJS.Timeout | null = null;
  private encerrando = false;

  /** Mensagem guardada agora (nunca com a privacidade ligada) — o atendente escuta aqui. */
  readonly chegou$ = new Subject<Recebida>();
  /** O dono escreveu numa conversa pelo celular (a conversa é dele agora). */
  readonly donoEscreveu$ = new Subject<string>();
  /** Ligação chegando, ou acabando (nunca com a privacidade ligada). O áudio não vem: só o aviso. */
  readonly ligacao$ = new Subject<Ligacao>();
  /** O que o próprio robô mandou: volta como "fromMe" e não pode passar por mensagem do dono. */
  private enviadas = new Set<string>();

  estado: EstadoWhatsapp = 'desligado';
  /** QR em data URL, enquanto espera o pareamento. */
  qr: string | null = null;
  numero: string | null = null;

  /** `entendido`: transcrição/descrição já feita (mídia só é entendida uma vez, e só quando pedem). */
  private recebidas: { m: Recebida; raw: WAMessage; entendido?: Promise<string | undefined> }[] = [];
  /** jid (qualquer forma: telefone ou LID) → nome, para mostrar quem mandou. */
  private nomes = new Map<string, string>();
  /** Para onde dá para mandar, pelo jid que o WhatsApp aceita. */
  private destinos = new Map<string, Destino>();
  /** jids cujo nome veio da agenda do celular (não troca pelo apelido). */
  private daAgenda = new Set<string>();
  /** Quem está em cada grupo (para o @), guardado por um tempo — pedir toda vez é lento. */
  private participantes = new Map<string, { em: number; pessoas: { id: string; nome: string }[] }>();
  /** A última conversa que o dono pediu para ver — "responde ele" vai para ela. */
  private ultimaVista: Destino | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly stt: SttService,
    private readonly vision: VisionService,
    private readonly tts: TtsService,
  ) {
    this.authDir = rootPath(`${cfg.DATA_DIR}/whatsapp-auth`);
    this.file = rootPath(`${cfg.DATA_DIR}/whatsapp.json`);
    this.contatosFile = rootPath(`${cfg.DATA_DIR}/whatsapp-contatos.json`);
    this.recebidasFile = rootPath(`${cfg.DATA_DIR}/whatsapp-recebidas.json`);
    this.historicoFile = rootPath(`${cfg.DATA_DIR}/whatsapp-historico.json`);
    try {
      this.c = { ...this.c, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Combinado>) };
    } catch {
      /* nunca conectou */
    }
    // Só nomes (da agenda do celular e dos grupos) — nenhuma mensagem. Numa reconexão o WhatsApp
    // não manda a agenda de novo, então sem isto os nomes sumiam a cada deploy.
    try {
      const salvo = JSON.parse(readFileSync(this.contatosFile, 'utf8')) as {
        nomes?: [string, string][];
        destinos?: Destino[];
        agenda?: string[];
        apelidos?: [string, string][];
      };
      this.nomes = new Map(salvo.nomes ?? []);
      this.apelidos = new Map(salvo.apelidos ?? []);
      this.daAgenda = new Set(salvo.agenda ?? []);
      this.destinos = new Map((salvo.destinos ?? []).map((d) => [d.id, d]));
    } catch {
      /* ainda sem contatos */
    }
    try {
      // BufferJSON: a mensagem crua tem bytes (chave da mídia) — sem ela o áudio/foto não baixa depois.
      const salvas = JSON.parse(readFileSync(this.recebidasFile, 'utf8'), BufferJSON.reviver) as { m: Recebida; raw: WAMessage }[];
      const corte = Date.now() - GUARDA_MS;
      if (!this.privado()) this.recebidas = salvas.filter((r) => r.m.ts > corte).slice(-MAX_RECEBIDAS);
    } catch {
      /* nada guardado */
    }
    try {
      const corte = Date.now() - HISTORICO_MS;
      const salvo = JSON.parse(readFileSync(this.historicoFile, 'utf8')) as Lembranca[];
      if (!this.privado()) this.historico = salvo.filter((l) => l.ts > corte).slice(-MAX_HISTORICO);
    } catch {
      /* nada guardado */
    }
  }

  onModuleInit(): void {
    // Só volta sozinho se já foi pareado antes; a primeira vez é pelo botão no app (precisa do QR).
    if (this.c.ativo && existsSync(join(this.authDir, 'creds.json'))) void this.conectar();
  }

  onModuleDestroy(): void {
    this.encerrando = true;
    if (this.religar) clearTimeout(this.religar);
    if (this.salvarContatos) this.gravarContatos();
    if (this.salvarRecebidas) this.gravarRecebidas();
    if (this.salvarHistorico) this.gravarHistorico();
    this.sock?.end(undefined);
  }

  get conectado(): boolean {
    return this.estado === 'conectado';
  }

  /* ───────────── privacidade ───────────── */

  privado(now = Date.now()): boolean {
    return this.c.privadoAte === -1 || this.c.privadoAte > now;
  }

  /** Liga (por `horas`, ou até pedir para voltar) ou desliga. Ligar apaga o que estava guardado. */
  definirPrivacidade(ligar: boolean, horas?: number): void {
    if (ligar) {
      this.c.privadoAte = horas && horas > 0 ? Date.now() + Math.min(horas, 24 * 30) * 3600_000 : -1;
      this.recebidas = [];
      this.historico = [];
      this.ultimaVista = null;
      rmSync(this.recebidasFile, { force: true }); // privacidade apaga do disco também, na hora
      rmSync(this.historicoFile, { force: true });
      this.log.log(`WhatsApp: privacidade ligada${this.c.privadoAte > 0 ? ` até ${new Date(this.c.privadoAte).toISOString()}` : ''}`);
    } else {
      this.c.privadoAte = 0;
      this.log.log('WhatsApp: privacidade desligada');
    }
    this.save();
  }

  get atender(): boolean {
    return this.c.atender;
  }

  definirAtender(ligar: boolean): void {
    this.c.atender = ligar;
    this.save();
    this.log.log(`WhatsApp: ${ligar ? 'atende' : 'não atende mais'} quem chama o robô`);
  }

  /**
   * Responder no lugar do dono: `contatos` são nomes, apelidos ou números (só privado). Devolve o que
   * ficou combinado, ou o erro para o cérebro perguntar ("tem mais de um Fábio").
   */
  cobrir(opts: { contatos?: string[]; todos?: boolean; exceto?: string[]; horas?: number }): string {
    if (!this.conectado) return 'erro: o WhatsApp não está conectado (o dono conecta pelo app, aba PC)';
    const achar = (nomes: string[] = []): { id: string; nome: string }[] | string => {
      const achados: { id: string; nome: string }[] = [];
      for (const nome of nomes) {
        const { destino, erro } = this.resolver(nome);
        if (!destino) return `erro em "${nome}": ${erro}`;
        if (destino.grupo) return `erro: "${destino.nome}" é grupo — grupo já fica de fora: no lugar dele você só responde conversa privada`;
        achados.push({ id: destino.id, nome: destino.nome });
      }
      return achados;
    };
    const achados = achar(opts.contatos);
    if (typeof achados === 'string') return achados;
    const exceto = opts.todos ? achar(opts.exceto) : [];
    if (typeof exceto === 'string') return exceto;
    if (!achados.length && !opts.todos) return 'erro: diga quais contatos (ou "todos", para todo mundo no privado)';
    const ate = opts.horas && opts.horas > 0 ? Date.now() + Math.min(opts.horas, 24 * 7) * 3600_000 : -1;
    this.c.cobrir = { ate, contatos: achados, todos: !!opts.todos, exceto };
    this.save();
    this.log.log(`WhatsApp: cobrindo o dono (${opts.todos ? 'todos' : achados.map((a) => a.nome).join(', ')})`);
    return `ok: ${this.descricaoCobertura()}`;
  }

  pararDeCobrir(): string {
    this.c.cobrir = null;
    this.save();
    this.log.log('WhatsApp: parou de cobrir o dono');
    return 'ok: você não responde mais no lugar dele (quem te chamar pelo nome continua falando com você)';
  }

  /** Esta mensagem é de alguém que o robô está respondendo no lugar do dono? */
  cobrindo(m: Recebida): boolean {
    const c = this.c.cobrir;
    if (!c || m.grupo || (c.ate > 0 && Date.now() > c.ate)) return false;
    const e = (x: { id: string }) => x.id === m.chat || x.id === m.alt;
    return c.todos ? !(c.exceto ?? []).some(e) : c.contatos.some(e);
  }

  private descricaoCobertura(): string {
    const c = this.c.cobrir;
    if (!c || (c.ate > 0 && Date.now() > c.ate)) return '';
    const hora = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: this.cfg.TZ_NAME });
    const fora = c.exceto?.length ? ` (menos ${c.exceto.map((x) => x.nome).join(', ')})` : '';
    const quem = c.todos ? `todo mundo no privado${fora}, grupos não` : c.contatos.map((x) => x.nome).join(', ');
    return `respondendo no lugar dele: ${quem}, ${c.ate > 0 ? `até ${hora.format(c.ate)}` : 'até ele pedir para parar'}`;
  }

  tecnico(chat: string): boolean {
    return this.c.gruposTecnicos.includes(chat);
  }

  definirGrupoTecnico(jid: string, ligar: boolean): void {
    const sem = this.c.gruposTecnicos.filter((g) => g !== jid);
    this.c.gruposTecnicos = ligar ? [...sem, jid] : sem;
    this.save();
    this.log.log(`WhatsApp: ${this.destinos.get(jid)?.nome ?? jid} ${ligar ? 'pode' : 'não pode mais'} tirar dúvida de código`);
  }

  /** Os grupos dele, para escolher no app quais tiram dúvida de código. */
  grupos(): { id: string; nome: string; tecnico: boolean }[] {
    return [...this.destinos.values()]
      .filter((d) => d.grupo)
      .map((d) => ({ id: d.id, nome: d.nome, tecnico: this.tecnico(d.id) }))
      .sort((a, b) => Number(b.tecnico) - Number(a.tecnico) || a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  /** Para o prompt do cérebro e para o app. */
  descricao(): string {
    if (!this.conectado) return this.c.ativo ? 'reconectando' : 'não conectado';
    if (!this.privado()) {
      const cobrindo = this.descricaoCobertura();
      return (
        (this.c.atender
          ? 'conectado; quem te chama pelo nome no WhatsApp (direto ou num grupo) fala com você direto (você só conversa, sem ferramentas, e recados chegam aqui)'
          : 'conectado; você NÃO está respondendo quem te chama pelo nome') + (cobrindo ? `; ${cobrindo}` : '')
      );
    }
    if (this.c.privadoAte === -1) return 'conectado, com PRIVACIDADE ligada (até o dono pedir para voltar)';
    const ate = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: this.cfg.TZ_NAME });
    return `conectado, com PRIVACIDADE ligada até ${ate.format(this.c.privadoAte)}`;
  }

  status() {
    return {
      estado: this.estado,
      qr: this.qr,
      numero: this.numero,
      privado: this.privado(),
      privadoAte: this.privado() ? this.c.privadoAte : 0,
      guardadas: this.recebidas.length,
      contatos: this.contatosDaAgenda(),
      atender: this.c.atender,
    };
  }

  /* ───────────── conexão ───────────── */

  async conectar(): Promise<void> {
    if (this.sock) return;
    this.c.ativo = true;
    this.save();
    this.estado = 'conectando';
    mkdirSync(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const version = await fetchLatestBaileysVersion()
      .then((r) => r.version)
      .catch(() => undefined);

    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: loggerQuieto(this.log),
      browser: Browsers.ubuntu('Miro'),
      // O celular só para de notificar quando um aparelho conectado fica "online". Aqui, nunca.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => void this.aoMudarConexao(sock, u));
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      // 'append' é o que chegou enquanto o servidor estava fora (deploy, queda) — antes ia fora e
      // a mensagem sumia. Mas o que o PRÓPRIO robô manda também volta como 'append' (fromMe):
      // esse não pode passar por "o dono escreveu".
      for (const raw of messages) {
        if (type === 'notify' || (type === 'append' && !raw.key.fromMe)) void this.aoReceber(raw);
      }
    });
    sock.ev.on('call', (cs) => cs.forEach((c) => void this.aoLigar(c)));
    sock.ev.on('contacts.upsert', (cs) => cs.forEach((c) => this.guardarContato(c)));
    sock.ev.on('messaging-history.set', ({ contacts }) => contacts.forEach((c) => this.guardarContato(c)));
    sock.ev.on('contacts.update', (cs) => cs.forEach((c) => this.guardarContato(c)));
    sock.ev.on('groups.upsert', (gs) => gs.forEach((g) => g.id && g.subject && this.guardarGrupo(g.id, g.subject)));
    sock.ev.on('groups.update', (gs) => gs.forEach((g) => g.id && g.subject && this.guardarGrupo(g.id, g.subject)));
  }

  /** Tira o aparelho conectado da conta (some da lista no celular) e esquece a sessão. */
  async desconectar(): Promise<void> {
    this.c.ativo = false;
    this.save();
    if (this.religar) clearTimeout(this.religar);
    const sock = this.sock;
    this.sock = null;
    await sock?.logout().catch(() => undefined);
    sock?.end(undefined);
    this.limparSessao();
  }

  private async aoMudarConexao(sock: Socket, u: Partial<{ connection: string; qr: string; lastDisconnect: { error?: Error } }>) {
    if (sock !== this.sock) return; // uma conexão antiga ainda falando
    if (u.qr) {
      this.estado = 'aguardando_qr';
      this.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 280 }).catch(() => null);
    }
    if (u.connection === 'open') {
      this.estado = 'conectado';
      this.qr = null;
      this.tentativas = 0;
      this.numero = sock.user?.id?.split(':')[0]?.split('@')[0] ?? null;
      this.log.log(`WhatsApp conectado (${this.numero ?? '?'})`);
      sock
        .groupFetchAllParticipating()
        .then((gs) => Object.values(gs).forEach((g) => this.guardarGrupo(g.id, g.subject)))
        .catch(() => undefined);
      void this.buscarAgenda(sock);
    }
    if (u.connection === 'close') {
      const codigo = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      this.sock = null;
      this.qr = null;
      this.estado = 'desligado';
      if (this.encerrando || !this.c.ativo) return;
      if (codigo === DisconnectReason.loggedOut) {
        // Tiraram o aparelho pelo celular: a sessão morreu, só com QR novo.
        this.log.warn('WhatsApp: o aparelho foi desconectado pelo celular');
        this.c.ativo = false;
        this.save();
        this.limparSessao();
        return;
      }
      const pareado = existsSync(join(this.authDir, 'creds.json')) && !!sock.authState.creds.registered;
      if (!pareado && codigo === DisconnectReason.timedOut) {
        // Ninguém leu o QR a tempo: espera o dono apertar "conectar" de novo.
        this.log.log('WhatsApp: QR expirou sem pareamento');
        this.c.ativo = false;
        this.save();
        return;
      }
      // Queda comum (rede, restart pedido pelo servidor): volta sozinho, com espera crescente.
      const espera = Math.min(60_000, 2_000 * 2 ** this.tentativas++);
      this.log.log(`WhatsApp caiu (${codigo ?? 'sem código'}); reconectando em ${Math.round(espera / 1000)} s`);
      this.estado = 'conectando';
      this.religar = setTimeout(() => void this.conectar(), espera);
    }
  }

  /**
   * Os nomes da agenda do celular ("Jaque - TaxResearch") vêm na sincronização de app state, que o
   * Baileys só faz junto com o histórico — e o histórico fica desligado aqui (não precisamos dele).
   * Então, sem nenhum contato ainda, pede a coleção dos contatos do zero. Logo depois de parear, a
   * chave dessa sincronização pode ainda não ter chegado do celular: por isso as novas tentativas.
   */
  private async buscarAgenda(sock: Socket, tentativa = 0): Promise<void> {
    if (sock !== this.sock || this.contatosDaAgenda() > 0) return;
    try {
      await sock.authState.keys.set({ 'app-state-sync-version': { critical_unblock_low: null } });
      await sock.resyncAppState(['critical_unblock_low'], true);
      this.log.log(`WhatsApp: agenda sincronizada (${this.contatosDaAgenda()} contatos)`);
    } catch (err) {
      this.log.warn(`WhatsApp: não deu para puxar a agenda (tentativa ${tentativa + 1}): ${(err as Error).message}`);
    }
    const espera = RESYNC_MS[tentativa];
    if (this.contatosDaAgenda() === 0 && espera) setTimeout(() => void this.buscarAgenda(sock, tentativa + 1), espera);
  }

  private contatosDaAgenda(): number {
    return this.daAgenda.size;
  }

  private limparSessao(): void {
    rmSync(this.authDir, { recursive: true, force: true });
    rmSync(this.contatosFile, { force: true });
    rmSync(this.recebidasFile, { force: true });
    this.nomes.clear();
    this.destinos.clear();
    this.daAgenda.clear();
    this.recebidas = [];
    this.ultimaVista = null;
    this.numero = null;
    this.estado = 'desligado';
  }

  /* ───────────── o que chega ───────────── */

  private async aoReceber(raw: WAMessage): Promise<void> {
    // Privacidade: nem guarda. É descartado aqui, antes de qualquer outra coisa.
    if (this.privado()) return;
    const k = raw.key;
    const chat = k.remoteJid;
    if (!chat || !k.id) return;
    if (k.fromMe) {
      if (!this.enviadas.delete(k.id)) this.donoEscreveu$.next(chat);
      return;
    }
    if (isJidStatusBroadcast(chat) || isJidBroadcast(chat) || isJidNewsletter(chat)) return;
    const c = conteudo(raw.message);
    if (!c) return;

    const grupo = !!isJidGroup(chat);
    const alt = (k as { remoteJidAlt?: string }).remoteJidAlt;
    const autorJid = grupo ? (k.participant ?? '') : chat;
    const autorAlt = grupo ? (k as { participantAlt?: string }).participantAlt : alt;
    // Nome que a própria pessoa usa no WhatsApp: vale para achar ela depois, se não estiver na agenda.
    if (raw.pushName && !this.nomes.has(autorJid)) {
      this.nomes.set(autorJid, raw.pushName);
      if (autorAlt) this.nomes.set(autorAlt, raw.pushName);
      if (!grupo) this.guardarDestino(isPnUser(alt) ? alt! : chat, raw.pushName, false);
    }
    const autor = this.nomes.get(autorJid) ?? (autorAlt && this.nomes.get(autorAlt)) ?? raw.pushName ?? numeroDe(autorAlt ?? autorJid);
    const nomeChat = grupo ? await this.nomeDoGrupo(chat) : autor;

    if (this.recebidas.some((r) => r.m.id === k.id)) return; // entregue de novo depois de uma queda
    this.recebidas.push({
      m: {
        id: k.id,
        chat,
        nomeChat,
        autor,
        autorId: autorJid || undefined,
        alt: !grupo && alt ? alt : undefined,
        grupo,
        ts: Number(raw.messageTimestamp ?? 0) * 1000 || Date.now(),
        ...c,
      },
      raw,
    });
    const corte = Date.now() - GUARDA_MS;
    this.recebidas = this.recebidas.filter((r) => r.m.ts > corte).slice(-MAX_RECEBIDAS);
    if (!this.salvarRecebidas) this.salvarRecebidas = setTimeout(() => this.gravarRecebidas(), 3_000);
    const m = this.recebidas.at(-1)!.m;
    if (m.texto.trim()) {
      const pn = !grupo && isPnUser(alt) ? alt : undefined;
      const corteHist = Date.now() - HISTORICO_MS;
      this.historico = [...this.historico, { chat, pn, nome: nomeChat, grupo, autor, texto: m.texto.slice(0, 500), ts: m.ts }]
        .filter((l) => l.ts > corteHist)
        .slice(-MAX_HISTORICO);
      if (!this.salvarHistorico) this.salvarHistorico = setTimeout(() => this.gravarHistorico(), 10_000);
    }
    this.chegou$.next(m);
  }

  /** Alguém ligando (ou a ligação acabando): só o aviso — quem grava é o app do PC, se o dono quiser. */
  private async aoLigar(c: WACallEvent): Promise<void> {
    if (this.privado()) return;
    const fase = c.status === 'offer' ? 'chegando' : ['timeout', 'reject', 'terminate'].includes(c.status) ? 'acabou' : null;
    if (!fase) return;
    const grupo = !!c.isGroup && !!c.groupJid;
    const nome = grupo
      ? await this.nomeDoGrupo(c.groupJid!)
      : (this.destinos.get(c.from)?.nome ??
        (c.callerPn && this.destinos.get(c.callerPn)?.nome) ??
        this.nomes.get(c.from) ??
        (c.callerPn && this.nomes.get(c.callerPn)) ??
        numeroDe(c.callerPn ?? c.from));
    this.ligacao$.next({ id: c.id, nome, grupo, video: !!c.isVideo, fase });
  }

  private async nomeDoGrupo(jid: string): Promise<string> {
    const conhecido = this.destinos.get(jid)?.nome;
    if (conhecido) return conhecido;
    const meta = await this.sock?.groupMetadata(jid).catch(() => undefined);
    if (meta?.subject) this.guardarGrupo(jid, meta.subject);
    return meta?.subject ?? 'grupo';
  }

  /** Participantes do grupo com o nome que o dono conhece (agenda) ou o que a pessoa usa. */
  private async pessoasDoGrupo(jid: string): Promise<{ id: string; nome: string }[]> {
    const guardado = this.participantes.get(jid);
    if (guardado && Date.now() - guardado.em < 10 * 60_000) return guardado.pessoas;
    const meta = await this.sock?.groupMetadata(jid).catch(() => undefined);
    const pessoas = (meta?.participants ?? [])
      .map((p) => ({
        id: p.id,
        nome: [p.id, p.lid, p.phoneNumber].map((j) => j && this.nomes.get(j)).find(Boolean) ?? p.name ?? p.notify ?? '',
      }))
      .filter((p) => p.nome);
    this.participantes.set(jid, { em: Date.now(), pessoas });
    return pessoas;
  }

  private guardarContato(c: Partial<Contact>): void {
    const nome = c.name || c.notify || c.verifiedName;
    if (!c.id || !nome) return;
    // O nome da agenda do celular ganha do apelido que a pessoa usa (que chega a cada mensagem).
    if (!c.name && [c.id, c.lid, c.phoneNumber].some((j) => j && this.daAgenda.has(j))) return;
    if (c.name) for (const j of [c.id, c.lid, c.phoneNumber]) if (j) this.daAgenda.add(j);
    for (const j of [c.id, c.lid, c.phoneNumber]) if (j) this.nomes.set(j, nome);
    // Manda pelo número de telefone quando dá: é a forma que o WhatsApp sempre aceita.
    const destino = [c.phoneNumber, c.id].find((j) => isPnUser(j)) ?? c.id;
    this.guardarDestino(destino, nome, false);
  }

  private guardarGrupo(id: string, nome: string): void {
    this.nomes.set(id, nome);
    this.guardarDestino(id, nome, true);
  }

  private guardarDestino(id: string, nome: string, grupo: boolean): void {
    const antes = this.destinos.get(id);
    if (antes?.nome === nome && antes.grupo === grupo) return;
    this.destinos.set(id, { id, nome, grupo });
    // A agenda chega em rajada (centenas de contatos de uma vez): grava uma vez só no fim.
    if (!this.salvarContatos) this.salvarContatos = setTimeout(() => this.gravarContatos(), 2_000);
  }

  private gravarRecebidas(): void {
    if (this.salvarRecebidas) clearTimeout(this.salvarRecebidas);
    this.salvarRecebidas = null;
    if (this.privado()) return;
    try {
      mkdirSync(dirname(this.recebidasFile), { recursive: true });
      const tmp = `${this.recebidasFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.recebidas.map(({ m, raw }) => ({ m, raw })), BufferJSON.replacer), { mode: 0o600 });
      renameSync(tmp, this.recebidasFile);
    } catch (err) {
      this.log.error(`Falha ao salvar as mensagens recentes: ${(err as Error).message}`);
    }
  }

  private gravarHistorico(): void {
    if (this.salvarHistorico) clearTimeout(this.salvarHistorico);
    this.salvarHistorico = null;
    if (this.privado()) return;
    try {
      mkdirSync(dirname(this.historicoFile), { recursive: true });
      const tmp = `${this.historicoFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.historico));
      renameSync(tmp, this.historicoFile);
    } catch (err) {
      this.log.error(`Falha ao salvar o histórico do WhatsApp: ${(err as Error).message}`);
    }
  }

  private gravarContatos(): void {
    if (this.salvarContatos) clearTimeout(this.salvarContatos);
    this.salvarContatos = null;
    try {
      mkdirSync(dirname(this.contatosFile), { recursive: true });
      const tmp = `${this.contatosFile}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ nomes: [...this.nomes], destinos: [...this.destinos.values()], agenda: [...this.daAgenda], apelidos: [...this.apelidos] }),
      );
      renameSync(tmp, this.contatosFile);
    } catch (err) {
      this.log.error(`Falha ao salvar os contatos do WhatsApp: ${(err as Error).message}`);
    }
  }

  /* ───────────── o que o cérebro usa ───────────── */

  /**
   * As mensagens que o dono pediu para ver. Sem `de`: a conversa da última mensagem que chegou,
   * com o que veio junto dela. Áudio é transcrito aqui, só agora que ele pediu.
   */
  async ler(opts: { de?: string; quantas?: number } = {}): Promise<string> {
    if (!this.conectado) return 'o WhatsApp não está conectado (o dono conecta pelo app, aba PC)';
    if (this.privado()) return 'a privacidade do WhatsApp está ligada: você não está olhando as mensagens. Só volta se o dono pedir.';
    if (!this.recebidas.length) return 'nenhuma mensagem nova chegou desde que você conectou (ou nas últimas 12 horas)';

    let escolha: { m: Recebida; raw: WAMessage }[];
    if (opts.de) {
      const conversas = [...new Map(this.recebidas.map((r) => [r.m.chat, { id: r.m.chat, nome: r.m.nomeChat }])).values()];
      const autores = this.recebidas.map((r) => ({ id: r.m.chat, nome: r.m.autor }));
      const { achou: pelaConversa, parecidos } = acharPorNome([...conversas, ...autores], opts.de);
      // Apelido ou número ("o cliente da padaria", "final 4321"): a conversa pelo que ele deu.
      const alvo = pelaConversa ? undefined : (this.apelidos.size || digitosDe(opts.de) ? this.resolver(opts.de).destino : undefined);
      const doAlvo = alvo && this.recebidas.find((r) => r.m.chat === alvo.id || this.historico.some((l) => l.chat === r.m.chat && l.pn === alvo.id));
      const achou = pelaConversa ?? (doAlvo ? { id: doAlvo.m.chat, nome: doAlvo.m.nomeChat } : undefined);
      if (!achou) {
        return parecidos.length
          ? `mais de uma conversa com esse nome: ${[...new Set(parecidos.map((p) => p.nome))].join(', ')}. Pergunte qual.`
          : `não chegou mensagem de "${opts.de}" nas últimas horas. Conversas com mensagem: ${conversas.map((c) => c.nome).join(', ')}`;
      }
      escolha = this.recebidas.filter((r) => r.m.chat === achou.id).slice(-Math.min(Math.max(opts.quantas ?? 5, 1), 15));
    } else if (opts.quantas && opts.quantas > 1) {
      escolha = this.recebidas.slice(-Math.min(opts.quantas, 15));
    } else {
      const ultima = this.recebidas.at(-1)!;
      escolha = this.recebidas
        .filter((r) => r.m.chat === ultima.m.chat && r.m.ts >= ultima.m.ts - RAJADA_MS)
        .slice(-MAX_RAJADA);
    }

    const ultima = escolha.at(-1)!.m;
    this.ultimaVista = { id: ultima.chat, nome: ultima.nomeChat, grupo: ultima.grupo };
    const hora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: this.cfg.TZ_NAME });
    const linhas: string[] = [];
    for (const r of escolha) {
      linhas.push(descrever(r.m, hora.format(r.m.ts), await this.entender(r)));
    }
    return linhas.join('\n');
  }

  /** A mensagem em texto (áudio transcrito, foto/figurinha descrita) — para o atendente. */
  async textoDe(id: string): Promise<string | null> {
    const r = this.recebidas.find((x) => x.m.id === id);
    return r ? corpo(r.m, await this.entender(r)) : null;
  }

  /** Só a transcrição do áudio (sem rótulo), para ver se chamaram o robô pelo nome falando. */
  async transcricao(id: string): Promise<string | undefined> {
    const r = this.recebidas.find((x) => x.m.id === id);
    return r?.m.tipo === 'audio' ? this.entender(r) : undefined;
  }

  /** Transcreve o áudio ou descreve a foto/figurinha — uma vez só por mensagem. */
  private entender(r: { m: Recebida; raw: WAMessage; entendido?: Promise<string | undefined> }): Promise<string | undefined> {
    if (!['audio', 'foto', 'figurinha'].includes(r.m.tipo)) return Promise.resolve(undefined);
    r.entendido ??= this.baixarEEntender(r.m, r.raw);
    return r.entendido;
  }

  private async baixarEEntender(m: Recebida, raw: WAMessage): Promise<string | undefined> {
    if (!this.sock) return undefined;
    if (m.tipo === 'audio' && (!this.stt.enabled || (m.segundos && m.segundos > MAX_VOICE_SECONDS))) return undefined;
    if (m.tipo !== 'audio' && !this.vision.enabled) return undefined;
    try {
      const arquivo = await downloadMediaMessage(raw, 'buffer', {}, { logger: loggerQuieto(this.log), reuploadRequest: this.sock.updateMediaMessage });
      if (m.tipo === 'audio') return (await this.stt.transcribe(arquivo, { dica: false })).text.trim() || undefined;
      // Figurinha é WebP (às vezes animado): o modelo de visão vê melhor o primeiro quadro em PNG.
      const sharp = (await import('sharp')).default;
      const png = await sharp(arquivo, { pages: 1 }).resize(768, 768, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      const desc = await this.vision.describe(png, 'image/png', m.texto, { de: m.autor, figurinha: m.tipo === 'figurinha' });
      return desc ?? undefined;
    } catch (err) {
      this.log.warn(`Não deu para entender ${m.tipo} do WhatsApp: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Figurinha animada com a cara do robô. Só pelo atendente (em nome dele) ou depois do "sim" do dono. */
  async enviarFigurinha(chat: string, face: Face): Promise<string | undefined> {
    if (!this.sock || !this.conectado) throw new Error('o WhatsApp não está conectado');
    const m = await this.sock.sendMessage(chat, { sticker: await figurinha(face), isAnimated: true });
    if (m?.key.id) this.enviadas.add(m.key.id);
    return m?.key.id ?? undefined;
  }

  /**
   * Um arquivo do computador do dono, como documento anexado (nome e conteúdo inteiros, não o texto
   * colado). `legenda` vai junto, embaixo. Só depois do "sim" do dono.
   */
  async enviarArquivo(chat: string, dados: Buffer, nome: string, legenda?: string): Promise<string | undefined> {
    if (!this.sock || !this.conectado) throw new Error('o WhatsApp não está conectado');
    const m = await this.sock.sendMessage(chat, {
      document: dados,
      fileName: nome,
      mimetype: tipoDoArquivo(nome),
      ...(legenda ? { caption: legenda } : {}),
    });
    if (m?.key.id) this.enviadas.add(m.key.id);
    this.log.log(`WhatsApp: arquivo ${nome} (${Math.round(dados.length / 1024)} KB) enviado para ${this.nomes.get(chat) ?? numeroDe(chat)}`);
    return m?.key.id ?? undefined;
  }

  /** Dá para mandar mensagem de voz? Precisa da voz do servidor (edge-tts ou ElevenLabs). */
  get temVoz(): boolean {
    return !!this.tts.provider;
  }

  /**
   * A fala do robô como mensagem de voz (a bolinha azul, não arquivo): o WhatsApp só mostra assim se
   * vier em Opus dentro de OGG. Só pelo atendente, em nome dele.
   */
  async enviarAudio(chat: string, texto: string, opts: { citando?: string } = {}): Promise<string | undefined> {
    if (!this.sock || !this.conectado) throw new Error('o WhatsApp não está conectado');
    // "@Fábio" falado vira "arroba Fábio": na voz, é só o nome.
    const mp3 = await this.tts.synth(texto.replace(/@(?=\p{L})/gu, ''));
    const ogg = await this.stt.ffmpeg(mp3, ['-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg']);
    const quoted = opts.citando ? this.recebidas.find((x) => x.m.id === opts.citando)?.raw : undefined;
    const m = await this.sock.sendMessage(chat, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true }, quoted ? { quoted } : undefined);
    if (m?.key.id) this.enviadas.add(m.key.id);
    this.log.log(`WhatsApp: áudio enviado para ${this.nomes.get(chat) ?? numeroDe(chat)} (${texto.length} caracteres)`);
    return m?.key.id ?? undefined;
  }

  /**
   * Para quem mandar: pelo nome falado, ou (sem nome) a última conversa que ele pediu para ver.
   * Devolve o destino, ou o que dizer ao dono quando não dá para saber.
   */
  resolver(nome?: string): { destino?: Destino; erro?: string } {
    if (!this.conectado) return { erro: 'o WhatsApp não está conectado (o dono conecta pelo app, aba PC)' };
    if (!nome?.trim()) {
      return this.ultimaVista
        ? { destino: this.ultimaVista }
        : { erro: 'não sei para quem: diga o nome do contato ou do grupo' };
    }
    // Apelido que ele mesmo deu ("o cliente da padaria") vem antes de tudo.
    const apelido = acharPorNome([...this.apelidos].map(([id, a]) => ({ id, nome: a })), nome).achou;
    if (apelido) return { destino: { id: apelido.id, nome: `${apelido.nome} (${this.nomeDe(apelido.id)})`, grupo: !!isJidGroup(apelido.id) } };
    const digitos = digitosDe(nome);
    if (digitos) return this.porNumero(digitos);
    const recentes = this.recebidas.map((r) => ({ id: r.m.chat, nome: r.m.nomeChat, grupo: r.m.grupo }));
    const lista = [...this.destinos.values(), ...recentes];
    const querGrupo = /\bgrupo\b/.test(semAcento(nome));
    const { achou, parecidos } = acharPorNome(querGrupo ? lista.filter((d) => d.grupo) : lista, nome);
    if (achou) return { destino: achou };
    // A mesma pessoa às vezes aparece duas vezes (número e LID): mesmo nome exato, fica com o número.
    if (parecidos.length > 1 && new Set(parecidos.map((p) => semAcento(p.nome))).size === 1) {
      return { destino: parecidos.find((p) => isPnUser(p.id)) ?? parecidos[0] };
    }
    if (parecidos.length) return { erro: `tem mais de um: ${parecidos.map((p) => `${p.nome}${p.grupo ? ' (grupo)' : ''}`).join(', ')}. Pergunte qual.` };
    if (naoENome(semAcento(nome))) {
      const talvez = comAPalavra(lista, nome);
      return talvez.length
        ? { erro: `"${nome}" sozinho é vago. Pode ser: ${talvez.map((p) => `${p.nome}${p.grupo ? ' (grupo)' : ''}`).join(', ')}. Pergunte se é esse — não chute` }
        : { erro: `"${nome}" não é nome de contato nem de grupo. Pergunte para quem é — não chute` };
    }
    return { erro: `não achei "${nome}" nos contatos nem nos grupos` };
  }

  /** Nome que ele conhece daquela conversa (agenda, o que a pessoa usa no WhatsApp) ou o número. */
  private nomeDe(jid: string): string {
    return this.destinos.get(jid)?.nome ?? this.nomes.get(jid) ?? this.historico.findLast((l) => l.chat === jid || l.pn === jid)?.nome ?? numeroDe(jid);
  }

  /** "Manda pro final 4321" / o número inteiro: acha entre quem ele conhece; número inteiro novo também vale. */
  private porNumero(digitos: string): { destino?: Destino; erro?: string } {
    const jids = new Set([...this.destinos.keys(), ...this.nomes.keys(), ...this.historico.flatMap((l) => (l.pn ? [l.pn] : []))]);
    const achados = [...jids].filter((j) => numeroBate(j, digitos));
    // O mesmo número às vezes aparece com ":dispositivo" — conta como um só.
    const unicos = [...new Map(achados.map((j) => [j.split('@')[0]!.split(':')[0]!, `${j.split('@')[0]!.split(':')[0]!}@s.whatsapp.net`])).values()];
    if (unicos.length === 1) return { destino: { id: unicos[0]!, nome: `${this.nomeDe(unicos[0]!)} (${numeroDe(unicos[0]!)})`, grupo: false } };
    if (unicos.length > 1) return { erro: `mais de um número termina em ${digitos}: ${unicos.slice(0, 5).map((j) => `${this.nomeDe(j)} (${numeroDe(j)})`).join(', ')}. Pergunte qual.` };
    const novo = jidDoNumero(digitos);
    if (novo) return { destino: { id: novo, nome: numeroDe(novo), grupo: false } };
    return { erro: `nenhuma conversa com número terminando em ${digitos}. Peça o número inteiro, com DDD.` };
  }

  /**
   * "O cliente que falou da nota fiscal": procura no texto dos últimos 7 dias. Achou uma conversa só, ela
   * vira a "última vista" — o "responde ele" e o apelido vão para ela.
   */
  procurar(sobre: string): string {
    if (this.privado()) return 'a privacidade do WhatsApp está ligada: você não está olhando as mensagens.';
    const achados = porAssunto(this.historico, sobre);
    if (!achados.length) return `nenhuma conversa dos últimos 7 dias fala de "${sobre}". Pergunte outro detalhe (o final do número, quando foi).`;
    const quando = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: this.cfg.TZ_NAME });
    if (achados.length === 1) {
      const { l } = achados[0]!;
      this.ultimaVista = { id: l.pn ?? l.chat, nome: l.nome, grupo: l.grupo };
    }
    const linhas = achados.map(({ l }) => {
      const numero = l.pn ? ` (${numeroDe(l.pn)})` : '';
      const apelido = this.apelidos.get(l.pn ?? l.chat);
      return `${l.nome}${numero}${apelido ? ` — você chama de "${apelido}"` : ''}${l.grupo ? `, no grupo, ${l.autor}` : ''} · ${quando.format(l.ts)}: "${l.texto.slice(0, 160)}"`;
    });
    return linhas.join('\n');
  }

  /** "Esse é o cliente da padaria": guarda o apelido (da conversa citada, ou da última que ele viu). */
  apelidar(apelido: string, para?: string): string {
    const limpo = apelido.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!limpo) return 'erro: falta o apelido';
    const { destino, erro } = this.resolver(para);
    if (!destino) return `erro: ${erro}`;
    this.apelidos.set(destino.id, limpo);
    if (!this.salvarContatos) this.salvarContatos = setTimeout(() => this.gravarContatos(), 2_000);
    return `guardado: "${limpo}" é ${this.nomeDe(destino.id)}${isPnUser(destino.id) ? ` (${numeroDe(destino.id)})` : ''}`;
  }

  /**
   * Marca como lida UMA mensagem — só as que chamaram o robô (o dono liberou: essas são com ele).
   * O resto do WhatsApp continua sem tique azul.
   */
  async marcarLida(id: string): Promise<void> {
    const r = this.recebidas.find((x) => x.m.id === id);
    if (r && this.sock) await this.sock.readMessages([r.raw.key]).catch(() => undefined);
  }

  /**
   * Só chamado depois do "sim" do dono — ou pelo atendente, em nome do robô. `citando`: responde
   * aquela mensagem. Em grupo, "@Nome" no texto vira menção de verdade; `marcar` (jids) entra
   * marcado no começo.
   */
  async enviar(chat: string, texto: string, opts: { citando?: string; marcar?: string[] } = {}): Promise<string | undefined> {
    if (!this.sock || !this.conectado) throw new Error('o WhatsApp não está conectado');
    const quoted = opts.citando ? this.recebidas.find((x) => x.m.id === opts.citando)?.raw : undefined;
    let final = texto;
    let mentions: string[] = [];
    if (isJidGroup(chat)) {
      const marcar = (opts.marcar ?? []).filter(Boolean);
      // A assinatura fica na primeira linha; a menção de quem chamou abre a segunda.
      if (marcar.length) {
        const quebra = final.indexOf('\n');
        const prefixo = marcar.map(arroba).join(' ');
        final = quebra >= 0 ? `${final.slice(0, quebra + 1)}${prefixo} ${final.slice(quebra + 1)}` : `${prefixo} ${final}`;
      }
      const r = aplicarMencoes(final, await this.pessoasDoGrupo(chat));
      final = r.texto;
      mentions = [...new Set([...marcar, ...r.mentions])];
    }
    const m = await this.sock.sendMessage(chat, { text: final, ...(mentions.length ? { mentions } : {}) }, quoted ? { quoted } : undefined);
    if (m?.key.id) {
      this.enviadas.add(m.key.id);
      if (this.enviadas.size > 200) this.enviadas.delete(this.enviadas.values().next().value!);
    }
    this.log.log(`WhatsApp enviado para ${this.nomes.get(chat) ?? numeroDe(chat)} (${texto.length} caracteres)`);
    return m?.key.id ?? undefined;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.c));
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`Falha ao salvar o WhatsApp: ${(err as Error).message}`);
    }
  }
}

const TIPOS: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** O tipo pelo nome — o WhatsApp mostra o ícone e abre com o app certo. */
export function tipoDoArquivo(nome: string): string {
  return TIPOS[nome.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** "5511999998888@s.whatsapp.net" → "+5511999998888". LID não é telefone: vira "alguém". */
function numeroDe(jid: string): string {
  const [n, dominio] = jid.split('@');
  return dominio === 's.whatsapp.net' && n ? `+${n.split(':')[0]}` : 'alguém';
}
