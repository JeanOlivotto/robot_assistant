import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { BehaviorSubject } from 'rxjs';
import type { WebSocket } from 'ws';

/** Uma ação que a máquina do dono sabe fazer. Quem define a lista é ele, no braco.config.json. */
export interface Acao {
  nome: string;
  descricao: string;
  /** Nomes dos parâmetros que a ação aceita (ex.: ["projeto"]). */
  params: string[];
}

export interface Resultado {
  ok: boolean;
  saida: string;
  erro?: string;
}

const TIMEOUT_MS = 60_000;
const SAIDA_MAX = 4000;

/**
 * O braço: um agente rodando na máquina do dono (apps/braco). O gateway manda pedidos, ele
 * executa e devolve a saída. Duas formas: uma ação da lista que ele cadastrou, ou um comando
 * escrito na hora — e esse só chega aqui depois que o dono aprovou no chat.
 */
@Injectable()
export class BracoService {
  private readonly log = new Logger(BracoService.name);
  private ws: WebSocket | null = null;
  private host = '';
  private pendentes = new Map<string, { resolve(r: Resultado): void; timer: NodeJS.Timeout }>();

  /** As ações que a máquina anunciou ao conectar. Vazio = braço desligado. */
  readonly acoes$ = new BehaviorSubject<Acao[]>([]);

  get online(): boolean {
    return this.ws !== null;
  }

  get maquina(): string {
    return this.host;
  }

  acoes(): Acao[] {
    return this.acoes$.value;
  }

  /** O agente conectou e disse o que sabe fazer. */
  conectou(ws: WebSocket, host: string, acoes: Acao[]): void {
    this.desconectou(); // um braço por vez: o novo toma o lugar
    this.ws = ws;
    this.host = host;
    this.acoes$.next(acoes);
    this.log.log(`Braço conectado em ${host} — ${acoes.length} ação(ões): ${acoes.map((a) => a.nome).join(', ')}`);
  }

  desconectou(): void {
    if (this.ws) this.log.log(`Braço de ${this.host} saiu`);
    this.ws = null;
    this.host = '';
    this.acoes$.next([]);
    for (const [, p] of this.pendentes) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, saida: '', erro: 'o braço desconectou no meio' });
    }
    this.pendentes.clear();
  }

  /** Chegou a resposta de um pedido. */
  resultado(id: string, r: Resultado): void {
    const p = this.pendentes.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendentes.delete(id);
    p.resolve({ ...r, saida: (r.saida ?? '').slice(0, SAIDA_MAX) });
  }

  /** Roda uma ação da lista. */
  rodarAcao(nome: string, args: Record<string, string> = {}): Promise<Resultado> {
    if (!this.acoes().some((a) => a.nome === nome)) {
      return Promise.resolve({ ok: false, saida: '', erro: `a máquina não conhece a ação "${nome}"` });
    }
    return this.enviar({ acao: nome, args });
  }

  /** Roda um comando escrito na hora. Só chame depois do dono aprovar. */
  rodarComando(cmd: string): Promise<Resultado> {
    return this.enviar({ cmd });
  }

  private enviar(corpo: { acao?: string; args?: Record<string, string>; cmd?: string }): Promise<Resultado> {
    const ws = this.ws;
    if (!ws) return Promise.resolve({ ok: false, saida: '', erro: 'a máquina não está conectada' });

    const id = randomUUID();
    return new Promise<Resultado>((resolve) => {
      const timer = setTimeout(() => {
        this.pendentes.delete(id);
        resolve({ ok: false, saida: '', erro: 'a máquina demorou demais para responder' });
      }, TIMEOUT_MS);
      this.pendentes.set(id, { resolve, timer });
      ws.send(JSON.stringify({ t: 'run', id, ...corpo }));
      this.log.log(`Pedido ao braço: ${corpo.acao ?? corpo.cmd}`);
    });
  }
}
