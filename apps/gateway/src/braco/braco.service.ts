import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { BehaviorSubject, Subject } from 'rxjs';
import type { WebSocket } from 'ws';
import { AcoesService, montar, paramsDe } from './acoes.service.js';

/** Uma ação que a máquina sabe fazer sem aprovação: cadastrada no painel ou anunciada por ela (acoes.json). */
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

/** Sistema da máquina: define em que shell o comando roda (sh no Linux/Mac, PowerShell no Windows). */
export type Sistema = 'linux' | 'windows' | 'mac';

/** Uma máquina conectada: o app do computador (Linux ou Windows) ou o apps/braco avulso. */
export interface Maquina {
  nome: string;
  sistema: Sistema;
  acoes: Acao[];
  /** Última vez que o dono mexeu nela (teclado/mouse): é a "que ele está usando". */
  ativaEm: number;
}

interface Conexao extends Maquina {
  ws: WebSocket;
}

const TIMEOUT_MS = 60_000;
const SAIDA_MAX = 4000;

/**
 * O braço: agentes rodando nas máquinas do dono (o app do computador, no Linux e no Windows, ou
 * o apps/braco avulso). O gateway manda pedidos, a máquina executa e devolve a saída. Duas
 * formas: uma ação da lista que ela anunciou, ou um comando escrito na hora — e esse só chega
 * aqui depois que o dono aprovou no chat. Várias máquinas ao mesmo tempo: sem dizer qual, vai
 * para a que ele está usando.
 */
@Injectable()
export class BracoService {
  private readonly log = new Logger(BracoService.name);

  constructor(@Optional() private readonly cadastro?: AcoesService) {}

  private readonly conexoes = new Map<WebSocket, Conexao>();
  private pendentes = new Map<string, { ws: WebSocket; resolve(r: Resultado): void; timer: NodeJS.Timeout }>();

  /** As máquinas conectadas agora (muda a cada entrada/saída). */
  readonly maquinas$ = new BehaviorSubject<Maquina[]>([]);
  /** Pedido de Wake-on-LAN (o MAC): o DeviceGateway repassa para o robô, que está na rede da casa. */
  readonly wol$ = new Subject<string>();
  /** O robô da mesa está conectado (é ele quem manda o sinal de ligar). O DeviceGateway atualiza. */
  roboNaRede = false;

  get online(): boolean {
    return this.conexoes.size > 0;
  }

  /** As máquinas, a que o dono está usando primeiro; em cada uma, as ações dela + as do painel. */
  maquinas(): Maquina[] {
    return [...this.conexoes.values()]
      .map(({ ws: _ws, ...m }) => ({ ...m, acoes: [...m.acoes, ...this.doPainel(m).filter((a) => !m.acoes.some((x) => x.nome === a.nome))] }))
      .sort((a, b) => b.ativaEm - a.ativaEm);
  }

  private doPainel(m: Pick<Maquina, 'nome' | 'sistema'>): Acao[] {
    return (this.cadastro?.para(m.nome, m.sistema) ?? []).map((a) => ({ nome: a.nome, descricao: a.descricao, params: paramsDe(a.comando) }));
  }

  /** Ações da máquina em uso (compatível com quem só conhece uma máquina). */
  acoes(): Acao[] {
    return this.escolher()?.acoes ?? [];
  }

  /** Uma máquina conectou e disse quem é e o que sabe fazer. Mesmo nome = a conexão nova toma o lugar. */
  conectou(ws: WebSocket, nome: string, acoes: Acao[], sistema: Sistema = 'linux', mac?: string): void {
    this.cadastro?.lembrar({ nome, sistema, mac });
    for (const [outro, c] of this.conexoes) if (c.nome === nome && outro !== ws) this.desconectou(outro);
    this.conexoes.set(ws, { ws, nome, sistema, acoes, ativaEm: Date.now() });
    this.maquinas$.next(this.maquinas());
    this.log.log(`Máquina conectada: ${nome} (${sistema}) — ${acoes.length} ação(ões)${acoes.length ? `: ${acoes.map((a) => a.nome).join(', ')}` : ''}`);
  }

  /** O dono está mexendo nessa máquina: ela passa a ser a padrão. */
  ativa(ws: WebSocket): void {
    const c = this.conexoes.get(ws);
    if (c) c.ativaEm = Date.now();
  }

  /** Sem argumento: desliga todas (usado nos testes e no fim). */
  desconectou(ws?: WebSocket): void {
    const alvo = ws ? [ws] : [...this.conexoes.keys()];
    for (const w of alvo) {
      const c = this.conexoes.get(w);
      if (!c) continue;
      this.conexoes.delete(w);
      this.log.log(`Máquina ${c.nome} saiu`);
      for (const [id, p] of this.pendentes) {
        if (p.ws !== w) continue;
        clearTimeout(p.timer);
        this.pendentes.delete(id);
        p.resolve({ ok: false, saida: '', erro: 'a máquina desconectou no meio' });
      }
    }
    this.maquinas$.next(this.maquinas());
  }

  /** Chegou a resposta de um pedido. */
  resultado(id: string, r: Resultado): void {
    const p = this.pendentes.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendentes.delete(id);
    p.resolve({ ...r, saida: (r.saida ?? '').slice(0, SAIDA_MAX) });
  }

  /**
   * A máquina pelo nome (sem diferença de maiúsculas; basta um pedaço, "win" acha "PC-WIN"), ou a
   * que o dono está usando. Null se não há nenhuma ou o nome não bate.
   */
  escolher(nome?: string): Maquina | null {
    const todas = this.maquinas();
    const n = nome?.trim().toLowerCase();
    if (!n) return todas[0] ?? null;
    return todas.find((m) => m.nome.toLowerCase() === n) ?? todas.find((m) => m.nome.toLowerCase().includes(n) || m.sistema === n) ?? null;
  }

  /** Roda uma ação da lista. */
  rodarAcao(nome: string, args: Record<string, string> = {}, maquina?: string): Promise<Resultado> {
    const m = this.escolher(maquina);
    if (!m) return Promise.resolve(this.semMaquina(maquina));
    const propria = [...this.conexoes.values()].find((c) => c.nome === m.nome)?.acoes.some((a) => a.nome === nome);
    if (propria) return this.enviar(m.nome, { acao: nome, args });
    // Do painel: o servidor monta o comando (escapado no shell daquela máquina) e manda pronto.
    const cadastrada = this.cadastro?.para(m.nome, m.sistema).find((a) => a.nome === nome);
    if (!cadastrada) return Promise.resolve({ ok: false, saida: '', erro: `a máquina ${m.nome} não conhece a ação "${nome}"` });
    let cmd: string;
    try {
      cmd = montar(cadastrada, args);
    } catch (err) {
      return Promise.resolve({ ok: false, saida: '', erro: (err as Error).message });
    }
    return this.enviar(m.nome, { cmd });
  }

  /** Roda um comando escrito na hora. Só chame depois do dono aprovar. */
  rodarComando(cmd: string, maquina?: string): Promise<Resultado> {
    const m = this.escolher(maquina);
    if (!m) return Promise.resolve(this.semMaquina(maquina));
    return this.enviar(m.nome, { cmd });
  }

  /** Computadores que já conectaram e estão desligados agora (com MAC: dá para ligar). */
  desligadas(): { nome: string; sistema: Sistema; podeLigar: boolean }[] {
    const ligadas = new Set(this.maquinas().map((m) => m.nome));
    return (this.cadastro?.conhecidas() ?? []).filter((m) => !ligadas.has(m.nome)).map((m) => ({ nome: m.nome, sistema: m.sistema, podeLigar: !!m.mac }));
  }

  /**
   * Liga um computador desligado (ou suspenso) pela rede: o robô manda o pacote mágico. Sem nome,
   * o único desligado que dá para ligar. Devolve o que dizer ao dono.
   */
  ligar(nome?: string): { ok: boolean; texto: string } {
    const n = nome?.trim().toLowerCase();
    const conhecidas = this.cadastro?.conhecidas() ?? [];
    const alvo = n
      ? (conhecidas.find((m) => m.nome.toLowerCase() === n) ?? conhecidas.find((m) => m.nome.toLowerCase().includes(n) || m.sistema === n))
      : conhecidas.filter((m) => m.mac && !this.maquinas().some((x) => x.nome === m.nome)).at(0);
    if (!alvo) return { ok: false, texto: n ? `não conheço o computador "${nome}"` : 'não tem computador desligado que eu saiba ligar' };
    if (this.maquinas().some((m) => m.nome === alvo.nome)) return { ok: true, texto: `${alvo.nome} já está ligado` };
    if (!alvo.mac) return { ok: false, texto: `não sei o endereço de rede de ${alvo.nome} (ele precisa abrir o app uma vez com a versão nova)` };
    if (!this.roboNaRede) return { ok: false, texto: 'o robô da mesa está desconectado, e é ele quem manda o sinal para ligar' };
    this.wol$.next(alvo.mac);
    this.log.log(`Ligar ${alvo.nome} (${alvo.mac}) pelo robô`);
    return { ok: true, texto: `sinal enviado para ligar ${alvo.nome}; costuma levar um minuto (só funciona se o Wake-on-LAN estiver ligado na BIOS dele)` };
  }

  private semMaquina(nome?: string): Resultado {
    if (!this.online) return { ok: false, saida: '', erro: 'a máquina não está conectada' };
    return { ok: false, saida: '', erro: `não achei a máquina "${nome}" (conectadas: ${this.maquinas().map((m) => m.nome).join(', ')})` };
  }

  private enviar(nome: string, corpo: { acao?: string; args?: Record<string, string>; cmd?: string }): Promise<Resultado> {
    const c = [...this.conexoes.values()].find((x) => x.nome === nome);
    if (!c) return Promise.resolve({ ok: false, saida: '', erro: 'a máquina não está conectada' });
    const id = randomUUID();
    return new Promise<Resultado>((resolve) => {
      const timer = setTimeout(() => {
        this.pendentes.delete(id);
        resolve({ ok: false, saida: '', erro: 'a máquina demorou demais para responder' });
      }, TIMEOUT_MS);
      this.pendentes.set(id, { ws: c.ws, resolve, timer });
      c.ws.send(JSON.stringify({ t: 'run', id, ...corpo }));
      this.log.log(`Pedido para ${c.nome}: ${corpo.acao ?? corpo.cmd}`);
    });
  }
}
