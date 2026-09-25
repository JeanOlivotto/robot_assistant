/*
 * O braço do Miro, dentro do app do computador: conecta no servidor (/braco) com a mesma senha
 * do app e executa o que chegar — você pedindo pelo celular, pelo chat ou pela voz. Quem decide
 * o que pode rodar é o servidor: comando escrito na hora só chega depois do seu "Pode rodar" no
 * chat; ação sem aprovação só as que você cadastrou em acoes.json (pasta do app). Aqui, a
 * chave geral: o item "Deixar o Miro usar este computador" na bandeja.
 *
 * Linux: sh. Windows: PowerShell. Programa com janela (navegador, editor) não termina logo:
 * depois de ESPERA_MS a resposta volta com o que saiu até ali e o programa segue aberto.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';

const WINDOWS = process.platform === 'win32';
const SISTEMA = WINDOWS ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
const ESPERA_MS = 20_000;
const SAIDA_MAX = 8000;
const RECONECTA_MS = 5000;
const ATIVO_A_CADA_MS = 30_000;

/** Aspas simples do shell: o argumento vira texto, nunca comando ('' no PowerShell, '\'' no sh). */
export function escapar(valor, windows = WINDOWS) {
  const v = String(valor);
  return windows ? `'${v.replace(/'/g, "''")}'` : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Monta o comando de uma ação, trocando {param} pelos argumentos escapados. */
export function montar(acao, args = {}, windows = WINDOWS) {
  return acao.comando.replace(/\{(\w+)\}/g, (_, nome) => {
    const v = args[nome];
    if (v === undefined) throw new Error(`falta o argumento "${nome}"`);
    return escapar(v, windows);
  });
}

function rodar(comando) {
  return new Promise((pronto) => {
    const [bin, args] = WINDOWS
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${comando}`]]
      : ['/bin/sh', ['-c', comando]];
    let saida = '';
    let fim = false;
    const junta = (d) => {
      if (saida.length < SAIDA_MAX) saida += d.toString();
    };
    let p;
    try {
      p = spawn(bin, args, { cwd: homedir(), windowsHide: true, detached: !WINDOWS, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return pronto({ ok: false, saida: '', erro: err.message });
    }
    p.stdout.on('data', junta);
    p.stderr.on('data', junta);
    const terminar = (r) => {
      if (fim) return;
      fim = true;
      clearTimeout(espera);
      pronto({ ...r, saida: (r.saida ?? saida).trim().slice(0, SAIDA_MAX) });
    };
    const espera = setTimeout(() => {
      p.unref(); // programa com janela: fica aberto, a resposta vai agora
      terminar({ ok: true, saida: `${saida.trim()}\n(continua rodando no computador)`.trim() });
    }, ESPERA_MS);
    p.on('error', (err) => terminar({ ok: false, saida, erro: err.message }));
    p.on('exit', (code) => terminar(code === 0 ? { ok: true, saida: saida.trim() || '(sem saída)' } : { ok: false, saida, erro: `terminou com código ${code}` }));
  });
}

export class Braco {
  /**
   * @param {{ servidor: string, pastaAcoes: string, aoEstado?(e: string): void }} o
   *   servidor: https://… do gateway; pastaAcoes: onde fica o acoes.json (opcional).
   */
  constructor(o) {
    this.url = `${o.servidor.replace(/^http/, 'ws')}/braco`;
    this.arquivoAcoes = o.pastaAcoes;
    this.aoEstado = o.aoEstado ?? (() => {});
    this.token = '';
    this.ligado = false;
    this.ws = null;
    this.tentativa = null;
    this.ultimoAtivo = 0;
  }

  get conectado() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Ações que você autorizou nesta máquina (acoes.json: [{ nome, descricao, params, comando }]). */
  acoes() {
    try {
      const lista = JSON.parse(readFileSync(this.arquivoAcoes, 'utf8'));
      return (Array.isArray(lista) ? lista : (lista.acoes ?? [])).filter((a) => a?.nome && a?.comando);
    } catch {
      return [];
    }
  }

  /** Liga com a senha do app (o painel/bolha a entrega depois do login). */
  ligar(token) {
    if (token) this.token = token;
    if (!this.token) return;
    const mudou = !this.ligado;
    this.ligado = true;
    if (mudou || !this.ws) this.#conectar();
  }

  desligar() {
    this.ligado = false;
    clearTimeout(this.tentativa);
    this.ws?.close();
    this.ws = null;
    this.aoEstado('desligado');
  }

  /** Você mexeu no computador: avisa o servidor (no máximo a cada 30 s) que esta é a máquina em uso. */
  ativo() {
    if (!this.conectado || Date.now() - this.ultimoAtivo < ATIVO_A_CADA_MS) return;
    this.ultimoAtivo = Date.now();
    this.ws.send(JSON.stringify({ t: 'ativo' }));
  }

  #conectar() {
    clearTimeout(this.tentativa);
    this.ws?.close();
    const ws = new WebSocket(`${this.url}?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      const acoes = this.acoes();
      ws.send(
        JSON.stringify({
          t: 'hello',
          host: hostname().slice(0, 60),
          sistema: SISTEMA,
          acoes: acoes.map((a) => ({ nome: a.nome, descricao: a.descricao ?? a.nome, params: a.params ?? [] })),
        }),
      );
      this.ultimoAtivo = Date.now();
      console.log(`[braço] conectado como ${hostname()} (${SISTEMA}), ${acoes.length} ação(ões)`);
      this.aoEstado('conectado');
    });
    ws.addEventListener('message', async (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t !== 'run') return;
      const r = await this.#atender(msg);
      console.log(`[braço] ${r.ok ? 'ok' : `falhou: ${r.erro ?? ''}`}`);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'result', id: msg.id, ...r }));
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return; // uma conexão mais nova já tomou o lugar
      this.ws = null;
      this.aoEstado('caiu');
      if (this.ligado) this.tentativa = setTimeout(() => this.#conectar(), RECONECTA_MS);
    });
    ws.addEventListener('error', () => {}); // o close vem logo depois e reconecta
  }

  #atender(pedido) {
    if (!this.ligado) return Promise.resolve({ ok: false, saida: '', erro: 'o uso do computador está desligado nele' });
    if (pedido.acao) {
      const acao = this.acoes().find((a) => a.nome === pedido.acao);
      if (!acao) return Promise.resolve({ ok: false, saida: '', erro: `não conheço a ação "${pedido.acao}"` });
      let comando;
      try {
        comando = montar(acao, pedido.args);
      } catch (err) {
        return Promise.resolve({ ok: false, saida: '', erro: err.message });
      }
      console.log(`[braço] ação ${acao.nome}: ${comando}`);
      return rodar(comando);
    }
    if (pedido.cmd) {
      console.log(`[braço] comando aprovado: ${pedido.cmd}`);
      return rodar(pedido.cmd);
    }
    return Promise.resolve({ ok: false, saida: '', erro: 'pedido vazio' });
  }
}
