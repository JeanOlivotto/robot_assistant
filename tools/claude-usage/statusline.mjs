#!/usr/bin/env node
/**
 * Barra de status do Claude Code que também manda o uso do plano para o robô (botão KEY2).
 *
 * O Claude Code chama este script a cada atualização da barra, com um JSON no stdin que traz
 * `rate_limits.five_hour` / `rate_limits.seven_day` (só em planos Pro/Max, depois da 1ª resposta).
 * O script imprime a barra na hora e posta os números num processo separado, sem segurar nada.
 *
 * Configuração em ~/.claude/robo-usage.json:
 *   { "url": "https://srv1966497.hstgr.cloud", "token": "<APP_TOKEN>" }
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_FILE = join(homedir(), '.claude', 'robo-usage.json');
const STATE_FILE = join(tmpdir(), 'robo-claude-usage.json');
/** Sem mudança nos números, reenvia de tempos em tempos só para o robô saber que estão frescos. */
const REFRESH_MS = 5 * 60_000;
const POST_TIMEOUT_MS = 8_000;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Processo filho: faz o POST e sai. Erros ficam quietos — a barra de status não é lugar de reclamar. */
async function post(body) {
  const cfg = readJson(CONFIG_FILE);
  if (!cfg?.url || !cfg?.token) return;
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/api/claude-usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body,
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function maybeSend(limits) {
  const sig = JSON.stringify([limits.five_hour?.used_percentage, limits.seven_day?.used_percentage]);
  const last = readJson(STATE_FILE);
  if (last?.sig === sig && Date.now() - last.at < REFRESH_MS) return;
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ sig, at: Date.now() }));
  } catch {
    /* sem estado: no pior caso manda de novo na próxima */
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--post', JSON.stringify({ rate_limits: limits })], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function pct(w) {
  return w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : null;
}

function statusLine(data) {
  const parts = [data.model?.display_name ?? 'Claude'];
  const five = pct(data.rate_limits?.five_hour);
  const week = pct(data.rate_limits?.seven_day);
  if (five) parts.push(`5h ${five}`);
  if (week) parts.push(`semana ${week}`);
  return parts.join(' · ');
}

async function main() {
  if (process.argv[2] === '--post') {
    await post(process.argv[3]).catch(() => {});
    return;
  }
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let data = {};
  try {
    data = JSON.parse(input);
  } catch {
    /* segue com a barra mínima */
  }
  process.stdout.write(statusLine(data));
  const limits = data.rate_limits;
  if (limits && (limits.five_hour || limits.seven_day)) maybeSend(limits);
}

await main();
