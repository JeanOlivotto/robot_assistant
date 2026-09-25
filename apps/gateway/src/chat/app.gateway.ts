import type { IncomingMessage } from 'node:http';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { WebSocket, WebSocketServer } from 'ws';
import { AppClientMessage, AppServerMessage } from '@robo/protocol';
import { tokenEquals } from '../auth/token.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { RobotStateService } from '../robot/robot-state.service.js';
import { rejectUpgrade, WsRouter } from '../ws/ws-router.service.js';
import { ChatService } from './chat.service.js';

const HEARTBEAT_MS = 30_000;

/** WebSocket do webapp em /app — o "celular" do robô. */
@Injectable()
export class AppGateway implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AppGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly alive = new WeakSet<WebSocket>();
  /** App aberto na tela (true) ou em segundo plano (false). */
  private readonly visible = new WeakMap<WebSocket, boolean>();
  private readonly subs: Subscription[] = [];
  private heartbeat?: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly router: WsRouter,
    private readonly chat: ChatService,
    private readonly robot: RobotStateService,
    private readonly calendar: CalendarService,
  ) {}

  onModuleInit(): void {
    this.router.register('/app', (req, socket, head, url) => {
      if (!tokenEquals(url.searchParams.get('token'), this.cfg.APP_TOKEN)) {
        this.log.warn(`Webapp recusado (senha errada) de ${req.socket.remoteAddress}`);
        rejectUpgrade(socket);
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });

    this.subs.push(
      this.chat.messages$.subscribe((message) => this.broadcast({ t: 'message', ts: Date.now(), message })),
      this.robot.view$.subscribe((robot) => this.broadcast({ t: 'robot', ts: Date.now(), robot })),
      this.calendar.appAgenda$.subscribe((items) => this.broadcast({ t: 'agenda', ts: Date.now(), items })),
      // Mensagem nova com o app aberto na tela: ele já viu, o robô não fica cobrando resposta.
      this.chat.state$.subscribe((s) => {
        if (s.waitingSince && this.anyVisibleOpen) queueMicrotask(() => this.chat.seen());
      }),
    );

    // Celular que dormiu com o app aberto deixa conexão pendurada: ping/pong derruba.
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!this.alive.has(ws)) {
          ws.terminate();
          continue;
        }
        this.alive.delete(ws);
        ws.ping();
      }
    }, HEARTBEAT_MS);
  }

  /** Algum app conectado E na tela agora (sem conexão nenhuma, ninguém viu nada). */
  private get anyVisibleOpen(): boolean {
    for (const ws of this.wss.clients) if (ws.readyState === WebSocket.OPEN && (this.visible.get(ws) ?? false)) return true;
    return false;
  }

  /** Alguém está com o app aberto e olhando? Se não, a resposta vira notificação. */
  get anyVisible(): boolean {
    for (const ws of this.wss.clients) if (this.visible.get(ws) ?? true) return true;
    return false;
  }

  onModuleDestroy(): void {
    clearInterval(this.heartbeat);
    this.subs.forEach((s) => s.unsubscribe());
    for (const ws of this.wss.clients) ws.close(1001, 'servidor desligando');
    this.wss.close();
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    this.alive.add(ws);
    ws.on('pong', () => this.alive.add(ws));
    this.log.log(`Webapp conectado (${req.socket.remoteAddress})`);

    this.send(ws, {
      t: 'snapshot',
      ts: Date.now(),
      messages: this.chat.history(100),
      robot: this.robot.view$.value,
      agenda: this.calendar.appAgenda$.value,
    });

    ws.on('message', (data, isBinary) => {
      this.alive.add(ws);
      if (isBinary) return;
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = AppClientMessage.safeParse(json);
      if (!parsed.success) {
        this.log.warn(`Webapp mandou mensagem fora do protocolo: ${parsed.error.issues[0]?.message}`);
        return;
      }
      const msg = parsed.data;
      if (msg.t === 'say') void this.chat.say(msg.text, 'text', { origem: msg.origem, maquina: msg.maquina });
      else if (msg.t === 'confirm') void this.chat.confirm(msg.proposal_id, msg.ok, msg.origem);
      else if (msg.t === 'presence') {
        this.visible.set(ws, msg.visible);
        if (msg.visible) this.chat.seen();
      }
      else this.send(ws, { t: 'pong', ts: Date.now() });
    });

    ws.on('close', () => this.log.log('Webapp desconectado'));
    ws.on('error', (err) => this.log.warn(`Webapp erro: ${err.message}`));
  }

  private broadcast(msg: AppServerMessage): void {
    for (const ws of this.wss.clients) this.send(ws, msg);
  }

  private send(ws: WebSocket, msg: AppServerMessage): void {
    const checked = AppServerMessage.safeParse(msg);
    if (!checked.success) {
      this.log.error(`Mensagem '${msg.t}' fora do protocolo do app: ${checked.error.issues[0]?.message}`);
      return;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(checked.data));
  }
}
