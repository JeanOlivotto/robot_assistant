import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void;

/** Um único listener de 'upgrade' no servidor HTTP, roteando por caminho (/device, /app). */
@Injectable()
export class WsRouter implements OnApplicationBootstrap {
  private readonly routes = new Map<string, UpgradeHandler>();

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  /** Chame no onModuleInit — antes do bootstrap. */
  register(path: string, handler: UpgradeHandler): void {
    this.routes.set(path, handler);
  }

  onApplicationBootstrap(): void {
    const server: Server = this.adapterHost.httpAdapter.getHttpServer();
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const handler = this.routes.get(url.pathname);
      if (handler) handler(req, socket, head, url);
      else socket.destroy();
    });
  }
}

export function rejectUpgrade(socket: Duplex, status = '401 Unauthorized'): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}
