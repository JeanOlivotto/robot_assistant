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
  SAY_MAX_BYTES: 63,
  /* OTA: a URL do binário e a versão que o robô mostra na telinha enquanto atualiza. */
  OTA_URL_MAX_BYTES: 191,
  OTA_VERSION_MAX_BYTES: 31,
  OTA_SHA256_BYTES: 64,
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
  'jamming',
  'angry',
  'evil',
] as const;
export type Face = (typeof FACES)[number];

export const BUTTON_IDS = ['boot', 'key1', 'key2'] as const;
export const BUTTON_EVENTS = ['short', 'long'] as const;
export const DISPLAY_MODES = ['alert'] as const;
export const WAKE_MODES = ['vad_local', 'ondevice_kw', 'button', 'none'] as const;
export const CODECS = ['adpcm', 'pcm16', 'opus'] as const;
/** Modo visual do robô. No 'hacker' o rosto inteiro fica vermelho. */
export const MODES = ['normal', 'hacker'] as const;
export type Mode = (typeof MODES)[number];

/** Fases da atualização de firmware, na ordem em que acontecem. */
export const OTA_PHASES = ['start', 'download', 'verify', 'done', 'error'] as const;

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
  /** A rede local do robô (fw 0.16.1+): o servidor usa para saber se o Wake-on-LAN alcança o PC. */
  rede: z.object({ ip: z.string().max(15), mask: z.string().max(15), ssid: z.string().max(32) }).optional(),
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

/**
 * O que o Bluetooth ouviu nos últimos ~10 s: aparelhos Apple por perto e o sinal de cada um.
 * Experimento de presença — o iPhone do dono na mesa aparece forte (perto de -50 dBm).
 */
export const Ble = z.object({
  t: z.literal('ble'),
  ts: epochMs,
  /** Aparelhos Apple distintos na janela. */
  n: z.number().int().min(0),
  /** Anúncios Apple ouvidos na janela, repetidos inclusive. */
  ads: z.number().int().min(0),
  /** Os de sinal mais forte, em ordem. `a`: fim do endereço (troca a cada ~15 min), `k`: tipo do anúncio. */
  dev: z
    .array(z.object({ a: z.string().max(12), r: z.number().int().min(-127).max(20), k: z.number().int().min(0).max(255) }))
    .max(8),
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

/** Como vai a atualização de firmware — o robô conta para o servidor enquanto baixa e grava. */
export const OtaStatus = z.object({
  t: z.literal('ota_status'),
  ts: epochMs,
  phase: z.enum(OTA_PHASES),
  /** 0–100 durante o download; ausente nas outras fases. */
  pct: z.number().int().min(0).max(100).optional(),
  version: bytes(LIMITS.OTA_VERSION_MAX_BYTES).optional(),
  detail: z.string().max(120).optional(),
});

export const DeviceMessage = z.discriminatedUnion('t', [Hello, Ping, Button, Battery, Ble, DeviceError, FaceReport, OtaStatus]);

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

/** Frase que o robô "fala" num balão na tela (pensamento, comentário). Não entra no chat. */
export const DeviceSay = z.object({
  t: z.literal('say'),
  ts: epochMs,
  text: bytes(LIMITS.SAY_MAX_BYTES),
  ms: z.number().int().min(1000).max(15_000),
});

/** O que o dono está ouvindo no Spotify — o robô mostra a tela de música (carinha com fone). */
export const Music = z.object({
  t: z.literal('music'),
  ts: epochMs,
  playing: z.boolean(),
  title: bytes(LIMITS.TITLE_MAX_BYTES),
  artist: bytes(LIMITS.SUB_MAX_BYTES),
});

/**
 * Tem firmware novo: baixe daqui e atualize sozinho (seção 7.4 do doc).
 * O robô valida o sha256 do que gravou antes de reiniciar; se a versão nova não conectar
 * no servidor, o bootloader volta para a anterior por conta própria.
 */
export const Ota = z.object({
  t: z.literal('ota'),
  ts: epochMs,
  version: bytes(LIMITS.OTA_VERSION_MAX_BYTES),
  url: bytes(LIMITS.OTA_URL_MAX_BYTES),
  sha256: z.string().length(LIMITS.OTA_SHA256_BYTES).regex(/^[0-9a-f]+$/),
  size: z.number().int().positive(),
});

/** Liga ou desliga o modo hacker — o robô também alterna sozinho no botão BOOT. */
export const SetMode = z.object({
  t: z.literal('mode'),
  ts: epochMs,
  v: z.enum(MODES),
});

/**
 * Liga um computador pela rede (Wake-on-LAN): o robô, que está sempre no Wi-Fi da casa, manda o
 * "pacote mágico" em broadcast para esse MAC. O servidor sozinho não alcança a rede local.
 */
export const Wol = z.object({
  t: z.literal('wol'),
  ts: epochMs,
  mac: z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/),
});

export const ServerMessage = z.discriminatedUnion('t', [
  HelloAck,
  Pong,
  State,
  Display,
  Agenda,
  Chat,
  Reaction,
  DeviceSay,
  Music,
  Ota,
  SetMode,
  Wol,
]);

export type Hello = z.infer<typeof Hello>;
export type Button = z.infer<typeof Button>;
export type DeviceMessage = z.infer<typeof DeviceMessage>;
export type HelloAck = z.infer<typeof HelloAck>;
export type Display = z.infer<typeof Display>;
export type AgendaItem = z.infer<typeof AgendaItem>;
export type Agenda = z.infer<typeof Agenda>;
export type Chat = z.infer<typeof Chat>;
export type Reaction = z.infer<typeof Reaction>;
export type DeviceSay = z.infer<typeof DeviceSay>;
export type Music = z.infer<typeof Music>;
export type Ota = z.infer<typeof Ota>;
export type SetMode = z.infer<typeof SetMode>;
export type Wol = z.infer<typeof Wol>;
export type OtaStatus = z.infer<typeof OtaStatus>;
export type ServerMessage = z.infer<typeof ServerMessage>;

export const DEVICE_MESSAGE_TYPES = DeviceMessage.options.map((o) => o.shape.t.value);
export const SERVER_MESSAGE_TYPES = ServerMessage.options.map((o) => o.shape.t.value);
