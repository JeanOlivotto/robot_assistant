/*
 * O olho do Miro no código: de tempos em tempos, o que está aberto no VS Code (pelo título da janela:
 * arquivo e projeto) e o que mudou no projeto (`git diff`). Vai para o servidor, e o Miro comenta —
 * ou não. Só sai código do projeto aberto: nada da tela, e nunca arquivo de segredo (.env, chave).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WINDOWS = process.platform === 'win32';
const DIFF_MAX = 8000;
const COMMITS_MAX = 2000;

/* Os mesmos de braco.js: arquivo de segredo não sai daqui. */
const SENSIVEL =
  /(^|[\/\\])(\.ssh|\.gnupg|\.aws|\.kube|\.docker)([\/\\]|$)|(^|[\/\\])\.env(\.[^\/\\]*)?$|\.(pem|key|p12|pfx|kdbx|keystore|jks)$|(^|[\/\\])id_(rsa|dsa|ecdsa|ed25519)[^\/\\]*$|credentials|secrets?([\/\\.]|$)|\.netrc$|\.pgpass$|wallet\.dat$/i;
/* Não é código de gente: não vale os tokens. */
const RUIDO = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock)$|\.min\.(js|css)$|\.(map|svg|png|jpe?g|gif|ico|woff2?|ttf|pdf|zip)$|(^|\/)(dist|build|node_modules)\//i;

function rodar(bin, args, opts = {}) {
  return new Promise((resolve) =>
    execFile(bin, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...opts }, (err, out) => resolve(err ? null : String(out))),
  );
}

/** O título da janela em foco agora. */
export async function janelaEmFoco() {
  if (!WINDOWS) return (await rodar('xdotool', ['getactivewindow', 'getwindowname']))?.trim() ?? null;
  const ps = `Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class Janela{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);}
"@
$s=New-Object System.Text.StringBuilder 512;[void][Janela]::GetWindowText([Janela]::GetForegroundWindow(),$s,512);$s.ToString()`;
  const cod = Buffer.from(ps, 'utf16le').toString('base64');
  return (await rodar('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', cod]))?.trim() ?? null;
}

/**
 * "● main.ts - robot_assistant - Visual Studio Code" → { arquivo: 'main.ts', projeto: 'robot_assistant' }.
 * Sem pasta aberta (só o arquivo) ou outra janela: null.
 */
export function lerTitulo(titulo) {
  const m = /^(?:●\s*)?(.+?)\s[-—]\s(.+?)(?:\s\[[^\]]+\])?\s[-—]\s(?:Visual Studio Code|Code - OSS|VSCodium|Cursor)(?:\s-\s.*)?$/.exec(String(titulo ?? '').trim());
  if (!m) return null;
  return { arquivo: m[1].trim(), projeto: m[2].trim() };
}

const pastas = new Map();

/** A pasta do projeto pelo nome (o VS Code mostra só o nome): procura onde costuma ficar, até 3 níveis. */
export function acharProjeto(nome, raizes = raizesPadrao()) {
  if (pastas.has(nome)) return pastas.get(nome);
  let achou = null;
  const visitar = (dir, nivel) => {
    if (achou || nivel > 3) return;
    let itens;
    try {
      itens = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const i of itens) {
      if (!i.isDirectory() || i.name === 'node_modules' || (i.name.startsWith('.') && nivel > 0)) continue;
      const caminho = join(dir, i.name);
      if (i.name === nome && existsSync(join(caminho, '.git'))) {
        achou = caminho;
        return;
      }
      visitar(caminho, nivel + 1);
    }
  };
  for (const r of raizes) if (existsSync(r)) visitar(r, 0);
  pastas.set(nome, achou);
  return achou;
}

function raizesPadrao() {
  const casa = homedir();
  return ['Projects', 'projects', 'Projetos', 'code', 'Code', 'dev', 'src', 'repos', 'source/repos', 'Documents/GitHub', 'Documentos/GitHub', 'workspace'].map(
    (d) => join(casa, d),
  );
}

/** Tira o valor de senha/token que apareça no diff (mesmo em arquivo comum). */
export function mascarar(texto) {
  return texto
    .replace(/\b(sk|pk|rk|ghp|gho|github_pat|xox[abp]|AKIA|AIza|eyJ)[A-Za-z0-9_\-]{8,}/g, '***')
    .replace(/((?:pass(?:word)?|senha|secret|token|api[_-]?key|apikey|auth)\w*["']?\s*[:=]\s*)(["']?)[^"'\s,;]{4,}/gi, '$1$2***');
}

/**
 * O `git diff` (commitado ou não, contra o HEAD) em pedaços por arquivo: sem segredo, sem lockfile,
 * o arquivo aberto primeiro, cortado em DIFF_MAX.
 */
export function resumirDiff(diff, arquivoAberto = '') {
  const pedacos = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const bons = pedacos
    .map((p) => ({ p, nome: /^diff --git a\/(.+?) b\//.exec(p)?.[1] ?? '' }))
    .filter(({ nome }) => nome && !SENSIVEL.test(nome) && !RUIDO.test(nome));
  bons.sort((a, b) => Number(b.nome.endsWith(arquivoAberto)) - Number(a.nome.endsWith(arquivoAberto)));
  let saida = '';
  for (const { p } of bons) {
    const limpo = mascarar(p.replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*\n/m, ''));
    if (saida.length + limpo.length > DIFF_MAX) {
      saida += limpo.slice(0, Math.max(0, DIFF_MAX - saida.length)) + '\n[…cortado]';
      break;
    }
    saida += limpo;
  }
  return saida.trim();
}

let ultimoVscode = null; // { titulo, em }
let ultimaOlhada = '';

/** Chamado a cada minuto: guarda o último VS Code em foco (você pode estar no navegador na hora de olhar). */
export async function reparar() {
  const t = await janelaEmFoco();
  if (t && lerTitulo(t)) ultimoVscode = { titulo: t, em: Date.now() };
}

/** O que mandar para o servidor agora, ou null (sem VS Code recente, sem projeto, nada novo). */
export async function olhar(recenteMs = 20 * 60_000) {
  if (!ultimoVscode || Date.now() - ultimoVscode.em > recenteMs) return null;
  const t = lerTitulo(ultimoVscode.titulo);
  const pasta = t && acharProjeto(t.projeto);
  if (!pasta) return null;
  const git = (args) => rodar('git', ['-C', pasta, '-c', 'core.quotepath=off', ...args]);
  const diff = resumirDiff((await git(['diff', 'HEAD', '--no-color', '--no-ext-diff', '-U2'])) ?? (await git(['diff', '--no-color', '-U2'])) ?? '', t.arquivo);
  const commits = diff ? '' : mascarar(((await git(['log', '--since=25 minutes ago', '--no-color', '--stat', '--format=%h %s', '-3'])) ?? '').trim()).slice(0, COMMITS_MAX);
  if (!diff && !commits) return null;
  // Nada mudou desde a última olhada: não manda de novo (nem gasta a cota do Miro).
  const marca = createHash('sha1').update(diff + commits).digest('hex');
  if (marca === ultimaOlhada) return null;
  ultimaOlhada = marca;
  return { projeto: t.projeto, arquivo: t.arquivo, diff, commits };
}
