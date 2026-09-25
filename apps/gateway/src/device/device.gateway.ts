import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { DeviceMessage, ServerMessage, type AgendaItem, type Hello } from '@robo/protocol';
import { AlertService } from '../alerts/alert.service.js';
import { BracoService } from '../braco/braco.service.js';
import { tokenEquals } from '../auth/token.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { ChatService, type ChatState } from '../chat/chat.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { FirmwareService } from '../firmware/firmware.service.js';
import { PresenceService } from '../presence/presence.service.js';
import { RobotStateService } from '../robot/robot-state.service.js';
import { SpotifyService, type MusicState } from '../spotify/spotify.service.js';
import { rejectUpgrade, WsRouter } from '../ws/ws-router.service.js';

const HELLO_TIMEOUT_MS = 10_000;
/** Seção 7.1: device manda ping a cada 15 s; derrubamos após 45 s sem tráfego. */
const IDLE_TIMEOUT_MS = 45_000;

interface Session {
  id: string;
  ws: WebSocket;
  ip: string;
  connectedAt: number;
  lastSeen: number;
  hello?: Hello;
  power?: string;
  /** Versão já oferecida nesta conexão — não adianta mandar atualizar duas vezes seguidas. */
  otaOffered?: string;
  /** Última notícia da atualização em andamento, para o /debug e o log. */
  ota?: string;
}

export interface SessionInfo {
  session: string;
  dev: string | null;
  fw: string | null;
  chip: string | null;
  ip: string;
  connectedAt: string;
  lastSeenAgoMs: number;
  ota: string | null;
}

/** Servidor WebSocket `robo-ws/1` em /device — `ws` puro, sem socket.io (seção 6.1). */
@Injectable()
export class DeviceGateway implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DeviceGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly sessions = new Set<Session>();
  private readonly subs: Subscription[] = [];
  private reaper?: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly router: WsRouter,
    private readonly calendar: CalendarService,
    private readonly alerts: AlertService,
    private readonly chat: ChatService,
    private readonly robot: RobotStateService,
    private readonly spotify: SpotifyService,
    private readonly firmware: FirmwareService,
    private readonly presence: PresenceService,
    private readonly braco: BracoService,
  ) {}

  onModuleInit(): void {
    this.router.register('/device', (req, socket, head, url) => {
      if (!tokenEquals(url.searchParams.get('token'), this.cfg.DEVICE_TOKEN)) {
        this.log.warn(`Conexão recusada (token inválido) de ${req.socket.remoteAddress}`);
        rejectUpgrade(socket);
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });

    this.subs.push(
      this.calendar.agenda$.subscribe((items) => this.broadcast(this.agendaMsg(items))),
      this.alerts.alerts$.subscribe((msg) => this.broadcast(msg)),
      this.chat.state$.subscribe((state) => this.broadcast(this.chatMsg(state))),
      this.chat.react$.subscribe((r) => this.broadcast({ t: 'react', ts: Date.now(), v: r.face, ms: r.ms })),
      this.robot.say$.subscribe((s) => this.broadcast({ t: 'say', ts: Date.now(), text: s.text, ms: s.ms })),
      this.chat.mode$.subscribe((v) => this.broadcast({ t: 'mode', ts: Date.now(), v })),
      this.spotify.music$.subscribe((m) => this.broadcast(this.musicMsg(m))),
      // Ligar um computador da casa: só o robô está na rede local para mandar o pacote mágico.
      this.braco.wol$.subscribe((mac) => this.broadcast({ t: 'wol', ts: Date.now(), mac })),
      // Firmware novo publicado agora: quem está conectado atualiza sem esperar reconectar.
      this.firmware.published$.subscribe(() => {
        for (const s of this.sessions) this.offerOta(s);
      }),
    );

    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const s of this.sessions) {
        if (now - s.lastSeen > IDLE_TIMEOUT_MS) {
          this.log.warn(`${this.label(s)} sem tráfego há ${IDLE_TIMEOUT_MS / 1000}s — derrubando`);
          s.ws.terminate();
        }
      }
    }, 5_000);
  }

  onModuleDestroy(): void {
    clearInterval(this.reaper);
    this.subs.forEach((s) => s.unsubscribe());
    for (const s of this.sessions) s.ws.close(1001, 'servidor desligando');
    this.wss.close();
  }

  list(): SessionInfo[] {
    const now = Date.now();
    return [...this.sessions].map((s) => ({
      session: s.id,
      dev: s.hello?.dev ?? null,
      fw: s.hello?.fw ?? null,
      chip: s.hello?.chip ?? null,
      ip: s.ip,
      connectedAt: new Date(s.connectedAt).toISOString(),
      lastSeenAgoMs: now - s.lastSeen,
      ota: s.ota ?? null,
    }));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const now = Date.now();
    const s: Session = {
      id: randomUUID(),
      ws,
      ip: req.socket.remoteAddress ?? '?',
      connectedAt: now,
      lastSeen: now,
    };
    this.sessions.add(s);

    const helloTimer = setTimeout(() => {
      if (!s.hello) ws.close(4001, 'hello não recebido');
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (data, isBinary) => {
      s.lastSeen = Date.now();
      if (isBinary) return; // áudio entra na Fase 1
      this.onText(s, data);
    });

    ws.on('close', (code) => {
      clearTimeout(helloTimer);
      this.sessions.delete(s);
      this.log.log(`${this.label(s)} desconectou (código ${code})`);
      if (![...this.sessions].some((x) => x.hello)) {
        this.robot.setOnline(false);
        this.braco.roboNaRede = false;
      }
    });

    ws.on('error', (err) => this.log.warn(`${this.label(s)} erro: ${err.message}`));
  }

  private onText(s: Session, data: RawData): void {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      this.log.warn(`${this.label(s)} mandou JSON inválido`);
      return;
    }
    const parsed = DeviceMessage.safeParse(json);
    if (!parsed.success) {
      this.log.warn(`${this.label(s)} mensagem fora do protocolo: ${parsed.error.issues[0]?.message}`);
      return;
    }

    const msg = parsed.data;
    switch (msg.t) {
      case 'hello':
        this.onHello(s, msg);
        break;
      case 'ping':
        this.send(s, { t: 'pong', ts: Date.now() });
        break;
      case 'face':
        this.robot.setFace(msg.v);
        break;
      case 'button':
        this.log.log(`${this.label(s)} botão ${msg.id} (${msg.ev})`);
        break;
      case 'battery': {
        // O robô manda a cada minuto; só vale log quando muda.
        const power = `${msg.mv < 0 ? 'sem leitura' : `${msg.mv} mV`}, usb=${msg.usb}`;
        if (power !== s.power) this.log.log(`${this.label(s)} energia: ${power}`);
        s.power = power;
        break;
      }
      case 'ble':
        this.presence.record(msg);
        break;
      case 'error':
        this.log.warn(`${this.label(s)} erro no device: ${msg.code} ${msg.detail ?? ''}`);
        break;
      case 'ota_status': {
        s.ota = msg.phase === 'download' ? `baixando ${msg.pct ?? 0}%` : msg.phase;
        const extra = [msg.version, msg.detail].filter(Boolean).join(' — ');
        // O download conta de 10 em 10%: só vale uma linha de log quando muda de fase.
        if (msg.phase === 'error') this.log.error(`${this.label(s)} atualização falhou: ${extra}`);
        else if (msg.phase !== 'download') this.log.log(`${this.label(s)} atualização: ${msg.phase} ${extra}`);
        break;
      }
    }
  }

  private onHello(s: Session, hello: Hello): void {
    s.hello = hello;
    this.log.log(`${this.label(s)} conectou — fw ${hello.fw}, chip ${hello.chip}, ip ${s.ip}`);
    this.robot.setOnline(true);
    this.braco.roboNaRede = true;

    const now = Date.now();
    this.send(s, {
      t: 'hello_ack',
      ts: now,
      session: s.id,
      tz: this.cfg.TZ_NAME,
      tz_posix: this.cfg.TZ_POSIX,
    });
    this.send(s, this.agendaMsg(this.calendar.agenda$.value));
    this.send(s, this.chatMsg(this.chat.state));
    this.send(s, this.musicMsg(this.spotify.music$.value));
    const active = this.alerts.active(now);
    if (active) this.send(s, active);
    this.offerOta(s);
  }

  /** O robô acabou de dizer em que versão está: se houver outra publicada, manda buscar. */
  private offerOta(s: Session): void {
    const fw = this.firmware.latest();
    if (!fw || !s.hello || s.hello.fw === fw.version || s.otaOffered === fw.version) return;
    s.otaOffered = fw.version;
    this.log.log(`${this.label(s)} está em ${s.hello.fw || '?'} e tem ${fw.version} publicado — mandando atualizar`);
    this.send(s, {
      t: 'ota',
      ts: Date.now(),
      version: fw.version,
      url: this.firmware.downloadUrl(),
      sha256: fw.sha256,
      size: fw.size,
    });
  }

  private agendaMsg(items: AgendaItem[]): ServerMessage {
    return { t: 'agenda', ts: Date.now(), items };
  }

  private musicMsg(m: MusicState): ServerMessage {
    return { t: 'music', ts: Date.now(), playing: m.playing, title: m.title, artist: m.artist };
  }

  private chatMsg(state: ChatState): ServerMessage {
    return {
      t: 'chat',
      ts: Date.now(),
      thinking: state.thinking,
      waiting_since: state.waitingSince,
      preview: state.preview,
    };
  }

  private broadcast(msg: ServerMessage): void {
    for (const s of this.sessions) if (s.hello) this.send(s, msg);
  }

  private send(s: Session, msg: ServerMessage): void {
    // Valida a saída também: o contrato vale nos dois sentidos.
    const checked = ServerMessage.safeParse(msg);
    if (!checked.success) {
      this.log.error(`Mensagem '${msg.t}' fora do protocolo, não enviada: ${checked.error.issues[0]?.message}`);
      return;
    }
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(checked.data));
  }

  private label(s: Session): string {
    return s.hello ? `[${s.hello.dev}]` : `[${s.ip}]`;
  }
}
