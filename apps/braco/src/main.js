/**
 * O braço do robô: roda na SUA máquina, conecta no gateway e executa o que você deixou ele fazer.
 *
 *   cp braco.config.example.json braco.config.json   # ajuste as ações
 *   node src/main.js
 *
 * Duas formas de pedido chegam aqui:
 *  - ação da lista: só o que está no braco.config.json, com os argumentos escapados;
 *  - comando escrito na hora: só se você ligou permitirComandoLivre, e o servidor só manda
 *    depois de você aprovar no chat.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 45_000;
const SAIDA_MAX = 8000;
const RECONECTA_MS = 5000;

function carregarConfig() {
  const caminho = process.argv[2] ?? resolve(raiz, 'braco.config.json');
  try {
    const cfg = JSON.parse(readFileSync(caminho, 'utf8'));
    if (!cfg.servidor || !cfg.token) throw new Error('faltam "servidor" e "token"');
    cfg.acoes = (cfg.acoes ?? []).filter((a) => a.nome && a.comando);
    return cfg;
  } catch (err) {
    console.error(`Não consegui ler ${caminho}: ${err.message}`);
    console.error('Copie braco.config.example.json para braco.config.json e ajuste.');
    process.exit(1);
  }
}

const cfg = carregarConfig();

/** Aspas simples para o shell: o argumento vira texto, nunca comando. */
function escapar(valor) {
  return `'${String(valor).replace(/'/g, `'\\''`)}'`;
}

/** Monta o comando de uma ação, trocando {param} pelos argumentos escapados. */
function montar(acao, args = {}) {
  return acao.comando.replace(/\{(\w+)\}/g, (_, nome) => {
    const v = args[nome];
    if (v === undefined) throw new Error(`falta o argumento "${nome}"`);
    return escapar(v);
  });
}

function rodar(comando) {
  return new Promise((pronto) => {
    execFile('/bin/sh', ['-c', comando], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const saida = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(0, SAIDA_MAX);
      if (err) pronto({ ok: false, saida, erro: err.killed ? 'demorou demais e foi interrompido' : err.message });
      else pronto({ ok: true, saida: saida || '(sem saída)' });
    });
  });
}

async function atender(pedido) {
  if (pedido.acao) {
    const acao = cfg.acoes.find((a) => a.nome === pedido.acao);
    if (!acao) return { ok: false, saida: '', erro: `não conheço a ação "${pedido.acao}"` };
    let comando;
    try {
      comando = montar(acao, pedido.args);
    } catch (err) {
      return { ok: false, saida: '', erro: err.message };
    }
    console.log(`→ ${acao.nome}: ${comando}`);
    return rodar(comando);
  }

  if (pedido.cmd) {
    if (!cfg.permitirComandoLivre) {
      return { ok: false, saida: '', erro: 'comando livre está desligado nesta máquina' };
    }
    console.log(`→ comando: ${pedido.cmd}`);
    return rodar(pedido.cmd);
  }

  return { ok: false, saida: '', erro: 'pedido vazio' };
}

function conectar() {
  const url = `${cfg.servidor}?token=${encodeURIComponent(cfg.token)}`;
  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`Braço conectado em ${cfg.servidor}`);
    ws.send(
      JSON.stringify({
        t: 'hello',
        host: hostname(),
        acoes: cfg.acoes.map((a) => ({ nome: a.nome, descricao: a.descricao ?? a.nome, params: a.params ?? [] })),
      }),
    );
  });

  ws.on('message', async (dados) => {
    let msg;
    try {
      msg = JSON.parse(dados.toString());
    } catch {
      return;
    }
    if (msg.t !== 'run') return;
    const r = await atender(msg);
    if (!r.ok) console.log(`  falhou: ${r.erro ?? ''}`);
    ws.send(JSON.stringify({ t: 'result', id: msg.id, ...r }));
  });

  ws.on('close', () => {
    console.log(`Conexão caiu — tentando de novo em ${RECONECTA_MS / 1000}s`);
    setTimeout(conectar, RECONECTA_MS);
  });

  ws.on('error', (err) => console.error(`Erro: ${err.message}`));
}

console.log(`Braço de ${hostname()}: ${cfg.acoes.length} ação(ões), comando livre ${cfg.permitirComandoLivre ? 'ligado' : 'desligado'}`);
conectar();
