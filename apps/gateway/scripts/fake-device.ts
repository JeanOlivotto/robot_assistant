/**
 * Simula o robô no terminal: conecta no gateway, manda hello/ping e imprime o que chega.
 * Uso: pnpm fake-device [host]   (padrão 127.0.0.1)
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { ServerMessage } from '@robo/protocol';

for (const p of [resolve('.env'), resolve('../../.env')]) {
  if (existsSync(p)) {
    process.loadEnvFile(p);
    break;
  }
}

const host = process.argv[2] ?? '127.0.0.1';
const port = process.env.PORT ?? '8080';
const token = process.env.DEVICE_TOKEN ?? '';
const url = `ws://${host}:${port}/device?token=${encodeURIComponent(token)}`;
const hhmmss = () => new Date().toLocaleTimeString('pt-BR');

const ws = new WebSocket(url);
let pinger: NodeJS.Timeout | undefined;

ws.on('open', () => {
  console.log(`${hhmmss()} conectado em ${host}:${port}`);
  ws.send(
    JSON.stringify({
      t: 'hello',
      ts: Date.now(),
      dev: 'fake-01',
      fw: '0.0.0-fake',
      chip: 'node',
      caps: { codec: [], wake: 'none', lcd: { w: 128, h: 128 } },
    }),
  );
  pinger = setInterval(() => ws.send(JSON.stringify({ t: 'ping', ts: Date.now() })), 15_000);
});

ws.on('message', (data) => {
  const json = JSON.parse(data.toString());
  const ok = ServerMessage.safeParse(json).success;
  if (json.t === 'pong') return;
  console.log(`${hhmmss()} ${ok ? '←' : '⚠ FORA DO PROTOCOLO ←'}`, JSON.stringify(json, null, 2));
});

ws.on('unexpected-response', (_req, res) => {
  console.error(`${hhmmss()} recusado: HTTP ${res.statusCode} (confira DEVICE_TOKEN no .env)`);
  process.exit(1);
});

ws.on('close', (code) => {
  clearInterval(pinger);
  console.log(`${hhmmss()} desconectado (${code})`);
  process.exit(0);
});

ws.on('error', (err) => console.error(`${hhmmss()} erro: ${err.message}`));
