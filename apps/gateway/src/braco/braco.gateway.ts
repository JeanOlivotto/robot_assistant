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
  /** O app do computador diz o sistema; o apps/braco avulso (sem o campo) roda em Linux. */
  sistema: z.enum(['linux', 'windows', 'mac']).default('linux'),
  /** MAC da placa de rede (para ligar pelo Wake-on-LAN quando estiver desligado). */
  mac: z
    .string()
    .transform((m) => m.toLowerCase().replace(/-/g, ':'))
    .pipe(z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/))
    .optional()
    .catch(undefined),
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

/** O dono está mexendo nesta máquina (teclado/mouse): comandos sem máquina escolhida vão para ela. */
const Ativo = z.object({ t: z.literal('ativo') });

const Entrada = z.discriminatedUnion('t', [Hello, Result, Ativo]);

/**
 * Porta de entrada do braço em /braco: o app do computador (entra com a mesma senha do app) ou o
 * apps/braco avulso (BRACO_TOKEN). Várias máquinas ao mesmo tempo, uma conexão por nome.
 */
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
      const token = url.searchParams.get('token');
      const vale = (esperado: string) => !!esperado && tokenEquals(token, esperado);
      if (!vale(this.cfg.BRACO_TOKEN) && !vale(this.cfg.APP_TOKEN)) {
        this.log.warn(`Braço recusado (token inválido) de ${req.socket.remoteAddress}`);
        return rejectUpgrade(socket);
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = req.socket.remoteAddress ?? '?';
    ws.on('message', (data: RawData) => this.onText(ws, data, ip));
    ws.on('close', () => this.braco.desconectou(ws));
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
    if (msg.t === 'hello') {
      this.log.log(`Máquina ${msg.host} entrou de ${ip}`);
      this.braco.conectou(ws, msg.host, msg.acoes, msg.sistema, msg.mac);
    } else if (msg.t === 'ativo') this.braco.ativa(ws);
    else this.braco.resultado(msg.id, { ok: msg.ok, saida: msg.saida, erro: msg.erro });
  }
}
