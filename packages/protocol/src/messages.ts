import { z } from 'zod';
import { DEVICE_STATES } from './states.js';

export const PROTOCOL = 'robo-ws/1';

/* Limites compartilhados com o firmware (viram #define no protocol.h).
   Tamanhos em BYTES UTF-8 — é o que cabe nos buffers C, sem contar o '\0'. */
export const LIMITS = {
  AGENDA_MAX_ITEMS: 8,
  TITLE_MAX_BYTES: 63,
  SUB_MAX_BYTES: 31,
  ID_MAX_BYTES: 23,
  PREVIEW_MAX_BYTES: 47,
} as const;

/** Expressões do rostinho — a ordem vira o enum robo_face_t do firmware. */
export const FACES = [
  'neutral',
  'happy',
  'love',
  'sleepy',
  'sleeping',
  'worried',
  'surprised',
  'sad',
  'error',
  'thinking',
  'bored',
] as const;
export type Face = (typeof FACES)[number];

export const BUTTON_IDS = ['boot', 'key1', 'key2'] as const;
export const BUTTON_EVENTS = ['short', 'long'] as const;
export const DISPLAY_MODES = ['alert'] as const;
export const WAKE_MODES = ['vad_local', 'ondevice_kw', 'button', 'none'] as const;
export const CODECS = ['adpcm', 'pcm16', 'opus'] as const;

export function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

const bytes = (max: number) =>
  z.string().refine((s) => utf8Bytes(s) <= max, { message: `máximo ${max} bytes UTF-8` });

/** epoch em milissegundos */
const epochMs = z.number().int().nonnegative();

/* ───────────── Device → Servidor ───────────── */

export const Hello = z.object({
  t: z.literal('hello'),
  ts: epochMs,
  dev: z.string().min(1).max(32),
  fw: z.string().max(16),
  chip: z.string().max(16),
  caps: z.object({
    codec: z.array(z.enum(CODECS)),
    sr: z.number().int().optional(),
    wake: z.enum(WAKE_MODES),
    lcd: z.object({ w: z.number().int(), h: z.number().int() }).optional(),
  }),
});

export const Ping = z.object({ t: z.literal('ping'), ts: epochMs });

/** Botão físico — o device já trata localmente; o servidor só é informado. */
export const Button = z.object({
  t: z.literal('button'),
  ts: epochMs,
  id: z.enum(BUTTON_IDS),
  ev: z.enum(BUTTON_EVENTS),
});

export const Battery = z.object({
  t: z.literal('battery'),
  ts: epochMs,
  mv: z.number().int(),
  usb: z.boolean(),
});

export const DeviceError = z.object({
  t: z.literal('error'),
  ts: epochMs,
  code: z.string().max(32),
  detail: z.string().max(200).optional(),
});

/** Expressão que o device está mostrando agora — o webapp espelha. Enviado quando muda. */
export const FaceReport = z.object({
  t: z.literal('face'),
  ts: epochMs,
  v: z.enum(FACES),
});

export const DeviceMessage = z.discriminatedUnion('t', [Hello, Ping, Button, Battery, DeviceError, FaceReport]);

/* ───────────── Servidor → Device ───────────── */

export const HelloAck = z.object({
  t: z.literal('hello_ack'),
  ts: epochMs,
  session: z.string(),
  tz: z.string(),
  /** TZ no formato POSIX, que é o que o newlib do ESP32 entende (ex.: "<-03>3") */
  tz_posix: z.string(),
});

export const Pong = z.object({ t: z.literal('pong'), ts: epochMs });

export const State = z.object({
  t: z.literal('state'),
  ts: epochMs,
  v: z.enum(DEVICE_STATES),
});

export const Display = z.object({
  t: z.literal('display'),
  ts: epochMs,
  mode: z.enum(DISPLAY_MODES),
  /** Identifica o alerta; o device ignora repetição do mesmo id. */
  id: bytes(LIMITS.ID_MAX_BYTES),
  title: bytes(LIMITS.TITLE_MAX_BYTES),
  sub: bytes(LIMITS.SUB_MAX_BYTES).optional(),
  /** Início do compromisso; com ele o device mostra contagem regressiva ao vivo. */
  at: epochMs.optional(),
  ttl_ms: z.number().int().positive(),
});

export const AgendaItem = z.object({
  id: bytes(LIMITS.ID_MAX_BYTES),
  title: bytes(LIMITS.TITLE_MAX_BYTES),
  start: epochMs,
  end: epochMs,
  all_day: z.boolean(),
});

/** Próximos compromissos, ordenados por início. Substitui a lista anterior inteira. */
export const Agenda = z.object({
  t: z.literal('agenda'),
  ts: epochMs,
  items: z.array(AgendaItem).max(LIMITS.AGENDA_MAX_ITEMS),
});

/**
 * Estado da conversa com o dono. O device decide a cara a partir disso:
 * pensando, esperando resposta (e há quanto tempo), ou nada.
 */
export const Chat = z.object({
  t: z.literal('chat'),
  ts: epochMs,
  thinking: z.boolean(),
  /** Quando o robô mandou algo que espera resposta; 0 = não está esperando. */
  waiting_since: epochMs,
  /** Trecho da última mensagem do robô, para o rodapé. */
  preview: bytes(LIMITS.PREVIEW_MAX_BYTES),
});

/** Reação momentânea (ex.: a emoção da resposta do LLM). */
export const Reaction = z.object({
  t: z.literal('react'),
  ts: epochMs,
  v: z.enum(FACES),
  ms: z.number().int().min(300).max(15_000),
});

export const ServerMessage = z.discriminatedUnion('t', [HelloAck, Pong, State, Display, Agenda, Chat, Reaction]);

export type Hello = z.infer<typeof Hello>;
export type Button = z.infer<typeof Button>;
export type DeviceMessage = z.infer<typeof DeviceMessage>;
export type HelloAck = z.infer<typeof HelloAck>;
export type Display = z.infer<typeof Display>;
export type AgendaItem = z.infer<typeof AgendaItem>;
export type Agenda = z.infer<typeof Agenda>;
export type Chat = z.infer<typeof Chat>;
export type Reaction = z.infer<typeof Reaction>;
export type ServerMessage = z.infer<typeof ServerMessage>;

export const DEVICE_MESSAGE_TYPES = DeviceMessage.options.map((o) => o.shape.t.value);
export const SERVER_MESSAGE_TYPES = ServerMessage.options.map((o) => o.shape.t.value);
