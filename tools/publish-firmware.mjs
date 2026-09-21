#!/usr/bin/env node
/**
 * Publica o firmware compilado no gateway. O robô pega sozinho pelo Wi-Fi na próxima
 * conexão (ou na hora, se já estiver conectado) — não precisa de cabo.
 *
 *   node tools/publish-firmware.mjs                       # usa firmware/build/robo.bin e o .env
 *   node tools/publish-firmware.mjs caminho/para/app.bin
 *
 * Servidor e senha saem do .env da raiz (PUBLIC_URL e APP_TOKEN) e podem ser sobrescritos
 * por variáveis de ambiente com os mesmos nomes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Lê o .env da raiz sem depender de pacote nenhum. */
function dotenv() {
  const out = {};
  try {
    for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* sem .env: vale o ambiente */
  }
  return out;
}

const env = { ...dotenv(), ...process.env };
const base = (env.PUBLIC_URL || 'https://srv1966497.hstgr.cloud').replace(/\/+$/, '');
const token = env.APP_TOKEN;
const file = resolve(process.argv[2] ?? resolve(root, 'firmware/build/robo.bin'));

if (!token) {
  console.error('Falta APP_TOKEN (no .env da raiz ou no ambiente).');
  process.exit(1);
}

let bin;
try {
  bin = readFileSync(file);
} catch {
  console.error(`Não achei ${file}.\nCompile antes: idf.py build (o .bin sai em firmware/build/robo.bin).`);
  process.exit(1);
}

// Mesma checagem que o servidor faz, para errar aqui e não lá: 0xE9 + esp_app_desc.
if (bin[0] !== 0xe9 || bin.readUInt32LE(0x20) !== 0xabcd5432) {
  console.error(`${file} não parece um app do ESP32 (mande robo.bin, não bootloader.bin nem partition-table.bin).`);
  process.exit(1);
}
const version = bin.subarray(0x30, 0x50).toString('utf8').replace(/\0.*$/, '');
const sha = createHash('sha256').update(bin).digest('hex');

console.log(`Enviando ${(bin.length / 1024).toFixed(0)} kB — versão ${version} (sha ${sha.slice(0, 12)}) para ${base}`);

const res = await fetch(`${base}/api/firmware`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
  body: bin,
});

if (!res.ok) {
  console.error(`O servidor recusou (${res.status}): ${await res.text().catch(() => '')}`);
  process.exit(1);
}

const { firmware } = await res.json();
console.log(`Publicado: ${firmware.version}. O robô atualiza sozinho assim que se conectar.`);
