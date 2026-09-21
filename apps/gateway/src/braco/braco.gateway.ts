import type { IncomingMessage } from 'node:http';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { z } from 'zod';
import { tokenEquals } from '../auth/token.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rejectUpgrade, WsRouter } from '../ws/ws-router.service.js';
import { BracoService } from './braco.service.js';

const Hello = z.object({
  t: z.literal('hello'),
  host: z.string().max(60),
  acoes: z
    .array(z.object({ nome: z.string().max(40), descricao: z.string().max(160), params: z.array(z.string().max(30)).default([]) }))
    .max(40),
});

const Result = z.object({
  t: z.literal('result'),
  id: z.string().max(64),
  ok: z.boolean(),
  saida: z.string().max(20_000).default(''),
  erro: z.string().max(500).optional(),
});

const Entrada = z.discriminatedUnion('t', [Hello, Result]);

/** Porta de entrada do braço (apps/braco) em /braco. Um agente por vez. */
@Injectable()
export class BracoGateway implements OnModuleInit {
  private readonly log = new Logger(BracoGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly router: WsRouter,
    private readonly braco: BracoService,
  ) {}

  onModuleInit(): void {
    this.router.register('/braco', (req, socket, head, url) => {
      if (!this.cfg.BRACO_TOKEN) {
        this.log.warn('Braço recusado: BRACO_TOKEN não configurado no servidor');
        return rejectUpgrade(socket);
      }
      if (!tokenEquals(url.searchParams.get('token'), this.cfg.BRACO_TOKEN)) {
        this.log.warn(`Braço recusado (token inválido) de ${req.socket.remoteAddress}`);
        return rejectUpgrade(socket);
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = req.socket.remoteAddress ?? '?';
    ws.on('message', (data: RawData) => this.onText(ws, data, ip));
    ws.on('close', () => this.braco.desconectou());
    ws.on('error', (err) => this.log.warn(`Braço: ${err.message}`));
  }

  private onText(ws: WebSocket, data: RawData, ip: string): void {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      return;
    }
    const parsed = Entrada.safeParse(json);
    if (!parsed.success) {
      this.log.warn(`Braço mandou mensagem fora do protocolo: ${parsed.error.issues[0]?.message}`);
      return;
    }
    const msg = parsed.data;
    if (msg.t === 'hello') this.braco.conectou(ws, `${msg.host} (${ip})`, msg.acoes);
    else this.braco.resultado(msg.id, { ok: msg.ok, saida: msg.saida, erro: msg.erro });
  }
}
