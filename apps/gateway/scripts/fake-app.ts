/**
 * Conversa com o robô pelo terminal, como o webapp faria.
 * Uso: pnpm --filter @robo/gateway fake-app "mensagem" ["outra mensagem" ...]
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { AppServerMessage, type ChatMessage } from '@robo/protocol';

for (const p of [resolve('.env'), resolve('../../.env')]) {
  if (existsSync(p)) {
    process.loadEnvFile(p);
    break;
  }
}

const say = process.argv.slice(2);
const url = `ws://127.0.0.1:${process.env.PORT ?? 8080}/app?token=${encodeURIComponent(process.env.APP_TOKEN ?? '')}`;
const ws = new WebSocket(url);
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
const show = (m: ChatMessage) => {
  const p = m.proposal ? `  [proposta ${m.proposal.status}: ${m.proposal.title} @ ${new Date(m.proposal.start).toLocaleString('pt-BR')}]` : '';
  console.log(`${secs()}s ${m.from === 'user' ? 'VOCÊ' : `ROBÔ (${m.face ?? '-'})`}: ${m.text}${p}`);
};

let waitingReplies = 0;
let lastRobot: ChatMessage | null = null;

ws.on('open', () => {
  const next = () => {
    const text = say.shift();
    if (!text) return;
    waitingReplies++;
    ws.send(JSON.stringify({ t: 'say', ts: Date.now(), text }));
  };
  next();
  ws.on('message', (data) => {
    const parsed = AppServerMessage.safeParse(JSON.parse(data.toString()));
    if (!parsed.success) return console.log('⚠ fora do protocolo', parsed.error.issues[0]);
    const msg = parsed.data;
    if (msg.t === 'snapshot') console.log(`${secs()}s snapshot: ${msg.messages.length} msgs, robô online=${msg.robot.online}, agenda=${msg.agenda.length}`);
    if (msg.t === 'robot') console.log(`${secs()}s estado: pensando=${msg.robot.thinking} esperando=${msg.robot.waiting_since ? 'sim' : 'não'} cara=${msg.robot.face}`);
    if (msg.t === 'message') {
      show(msg.message);
      if (msg.message.from === 'robot') {
        lastRobot = msg.message;
        if (--waitingReplies <= 0) {
          if (say.length) setTimeout(() => {
            const text = say.shift()!;
            waitingReplies++;
            ws.send(JSON.stringify({ t: 'say', ts: Date.now(), text }));
          }, 300);
          else setTimeout(() => ws.close(), 1500);
        }
      }
    }
  });
});
ws.on('close', () => {
  void lastRobot;
  process.exit(0);
});
ws.on('unexpected-response', (_q, r) => {
  console.error(`recusado: HTTP ${r.statusCode}`);
  process.exit(1);
});
setTimeout(() => {
  console.log('tempo esgotado');
  process.exit(1);
}, 180_000);
