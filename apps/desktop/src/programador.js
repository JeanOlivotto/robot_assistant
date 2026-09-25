/*
 * "Miro, cria uma página de receitas": um programador de verdade faz o trabalho, numa pasta só
 * do projeto (~/Projects/miro/<projeto>). Leva minutos, então roda em segundo plano e avisa no
 * fim. O motor é trocável — hoje o Claude Code (a CLI `claude`, com o plano do dono); outro entra
 * como mais uma linha em MOTORES, e o servidor escolhe qual pelo PROGRAMADOR do .env.
 *
 * Segurança: o programador só edita arquivos DENTRO da pasta do projeto (sem terminal), e o nome
 * do projeto vira um nome de pasta limpo — nada de "../".
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WINDOWS = process.platform === 'win32';
const LIMITE_MS = 20 * 60_000;
const PASTA = join(homedir(), 'Projects', 'miro');
const MARCA = '.miro'; // existe = o programador já trabalhou aqui: continua a conversa de onde parou

/** "Página de Receitas!" → "pagina-de-receitas". */
export function nomeDePasta(projeto) {
  const s = String(projeto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return s || 'projeto';
}

const INSTRUCOES = [
  'Você está trabalhando a pedido do dono, que fala com o assistente Miro por voz ou pelo celular e não está vendo o terminal.',
  'Faça o que ele pediu por completo, só com arquivos DENTRO desta pasta. Se for página ou site, deixe um index.html na raiz que abra direto no navegador (sem precisar de servidor nem de build), com CSS e JS no próprio projeto.',
  'Não pergunte nada: decida o que for razoável. No fim, responda em português, em no máximo duas frases, o que ficou pronto — é isso que o Miro vai falar para ele.',
].join(' ');

/** Onde está a CLI do Claude: o app abre pelo bspwm/Windows sem o PATH do terminal. */
function acharClaude() {
  const casa = homedir();
  const candidatos = WINDOWS
    ? [join(process.env.APPDATA ?? '', 'npm', 'claude.cmd'), join(casa, '.local', 'bin', 'claude.exe'), join(casa, '.claude', 'local', 'claude.exe')]
    : [join(casa, '.local', 'bin', 'claude'), join(casa, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/usr/bin/claude'];
  return candidatos.find((c) => c && existsSync(c)) ?? 'claude';
}

/** Os motores: devolvem [programa, argumentos] para rodar na pasta do projeto. */
const MOTORES = {
  claude: (pedido, continuar) => [
    acharClaude(),
    [
      '-p',
      pedido,
      ...(continuar ? ['--continue'] : []),
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--disallowedTools',
      'Bash',
      '--append-system-prompt',
      INSTRUCOES,
    ],
  ],
};

/** Tira a resposta final do que o motor imprimiu (JSON do Claude Code, ou texto puro). */
function respostaDe(saida) {
  try {
    const j = JSON.parse(saida.trim().split('\n').at(-1));
    if (typeof j.result === 'string') return { texto: j.result, erro: j.is_error ? j.result : null };
  } catch {
    /* não era JSON */
  }
  return { texto: saida.trim().slice(-1500), erro: null };
}

function abrirNoNavegador(arquivo) {
  const [bin, args] = WINDOWS ? ['cmd', ['/c', 'start', '', arquivo]] : ['xdg-open', [arquivo]];
  try {
    spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* sem navegador: o caminho vai na resposta */
  }
}

/**
 * Faz o trabalho e resolve com { ok, saida, erro }. `saida` é o que o Miro conta ao dono.
 * @param {{ projeto: string, pedido: string, motor?: string }} p
 */
export function programar(p) {
  const motor = MOTORES[p.motor ?? 'claude'];
  if (!motor) return Promise.resolve({ ok: false, saida: '', erro: `não conheço o programador "${p.motor}"` });
  const pasta = join(PASTA, nomeDePasta(p.projeto));
  mkdirSync(pasta, { recursive: true });
  const continuar = existsSync(join(pasta, MARCA));
  const [bin, args] = motor(String(p.pedido).slice(0, 4000), continuar);
  console.log(`[programador] ${continuar ? 'continuando' : 'começando'} ${pasta}: ${String(p.pedido).slice(0, 120)}`);

  return new Promise((pronto) => {
    let saida = '';
    let erroTxt = '';
    let fim = false;
    let proc;
    try {
      proc = spawn(bin, args, { cwd: pasta, windowsHide: true, shell: WINDOWS && bin.endsWith('.cmd'), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return pronto({ ok: false, saida: '', erro: err.message });
    }
    proc.stdout.on('data', (d) => (saida += d));
    proc.stderr.on('data', (d) => (erroTxt += d));
    const terminar = (r) => {
      if (fim) return;
      fim = true;
      clearTimeout(limite);
      pronto(r);
    };
    const limite = setTimeout(() => {
      proc.kill();
      terminar({ ok: false, saida: '', erro: `passou de ${LIMITE_MS / 60_000} minutos e parei` });
    }, LIMITE_MS);
    proc.on('error', (err) =>
      terminar({ ok: false, saida: '', erro: err.code === 'ENOENT' ? 'o Claude Code não está instalado neste computador' : err.message }),
    );
    proc.on('exit', (code) => {
      const { texto, erro } = respostaDe(saida);
      if (code !== 0 || erro) return terminar({ ok: false, saida: texto, erro: erro ?? (erroTxt.trim().slice(-300) || `terminou com código ${code}`) });
      writeFileSync(join(pasta, MARCA), `${new Date().toISOString()}\n`);
      const index = join(pasta, 'index.html');
      if (existsSync(index) && !process.env.ROBO_SEM_NAVEGADOR) abrirNoNavegador(index);
      terminar({ ok: true, saida: `${texto}\n(pasta: ${pasta}${existsSync(index) ? ' — abri no navegador' : ''})` });
    });
  });
}
