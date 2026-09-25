import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppServerMessage,
  type AgendaItem,
  type AppClientMessage,
  type ChatMessage,
  type RobotView,
} from '@robo/protocol';
import { cabecalhosDeOnde, deOnde } from './origem';

export type Conn = 'connecting' | 'open' | 'offline';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

export interface Robo {
  conn: Conn;
  messages: ChatMessage[];
  robot: RobotView | null;
  agenda: AgendaItem[];
  say(text: string): boolean;
  confirm(proposalId: string, ok: boolean): void;
  /** Manda uma mensagem de voz; devolve o texto entendido. A resposta chega pelo WebSocket. */
  sendVoice(audio: Blob): Promise<string>;
}

/** Senha do webapp: confere no servidor antes de abrir o WebSocket. */
export async function checkToken(token: string): Promise<boolean> {
  const res = await fetch('/api/session', { headers: { Authorization: `Bearer ${token}` } });
  return res.status === 204;
}

function upsert(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const i = list.findIndex((m) => m.id === msg.id);
  if (i < 0) return [...list, msg].sort((a, b) => a.ts - b.ts);
  const copy = list.slice();
  copy[i] = msg;
  return copy;
}

/** Conexão com o gateway (/app): reconecta sozinha e volta na hora quando o app reabre. */
export function useRobo(token: string): Robo {
  const [conn, setConn] = useState<Conn>('connecting');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [robot, setRobot] = useState<RobotView | null>(null);
  const [agenda, setAgenda] = useState<AgendaItem[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pinger: ReturnType<typeof setInterval> | undefined;
    let disposed = false;

    const connect = () => {
      clearTimeout(retry);
      if (disposed || wsRef.current) return;
      setConn('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/app?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setConn('open');
        send(ws, { t: 'presence', ts: Date.now(), visible: document.visibilityState === 'visible' });
        pinger = setInterval(() => send(ws, { t: 'ping', ts: Date.now() }), 25_000);
      };
      ws.onmessage = (ev) => {
        const parsed = AppServerMessage.safeParse(JSON.parse(String(ev.data)));
        if (!parsed.success) return console.warn('mensagem fora do protocolo', parsed.error.issues);
        const msg = parsed.data;
        switch (msg.t) {
          case 'snapshot':
            setMessages(msg.messages);
            setRobot(msg.robot);
            setAgenda(msg.agenda);
            break;
          case 'message':
            setMessages((list) => upsert(list, msg.message));
            break;
          case 'robot':
            setRobot(msg.robot);
            break;
          case 'agenda':
            setAgenda(msg.items);
            break;
          case 'pong':
            break;
        }
      };
      ws.onclose = () => {
        clearInterval(pinger);
        wsRef.current = null;
        if (disposed) return;
        setConn('offline');
        retry = setTimeout(connect, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
      };
    };

    // iPhone congela a aba em segundo plano: ao voltar, reconecta sem esperar o backoff.
    // Também avisa o servidor: com o app em segundo plano, a resposta do robô vira notificação.
    const onVisible = () => {
      const visible = document.visibilityState === 'visible';
      send(wsRef.current, { t: 'presence', ts: Date.now(), visible });
      if (visible && !wsRef.current) {
        attempt = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    connect();

    return () => {
      disposed = true;
      clearTimeout(retry);
      clearInterval(pinger);
      document.removeEventListener('visibilitychange', onVisible);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [token]);

  const say = useCallback((text: string) => send(wsRef.current, { t: 'say', ts: Date.now(), text, ...deOnde() }), []);
  const confirm = useCallback(
    (proposalId: string, ok: boolean) => void send(wsRef.current, { t: 'confirm', ts: Date.now(), proposal_id: proposalId, ok, ...deOnde() }),
    [],
  );

  const sendVoice = useCallback(
    async (audio: Blob) => {
      const res = await fetch('/api/voice', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': audio.type || 'application/octet-stream', ...cabecalhosDeOnde() },
        body: audio,
      });
      const body = (await res.json().catch(() => ({}))) as { text?: string; message?: string };
      if (!res.ok) throw new Error(body.message || `erro ${res.status}`);
      return body.text ?? '';
    },
    [token],
  );

  return { conn, messages, robot, agenda, say, confirm, sendVoice };
}

function send(ws: WebSocket | null, msg: AppClientMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}
