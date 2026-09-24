/**
 * Protocolo do webapp (ws://host:8080/app?token=...). Só JSON; o webapp é o "celular" do robô.
 * Separado do robo-ws/1 porque não passa pelo firmware.
 */
import { z } from 'zod';
import { AgendaItem, FACES } from './messages.js';

const epochMs = z.number().int().nonnegative();

export const PROPOSAL_STATUS = ['pending', 'confirmed', 'cancelled', 'expired', 'failed'] as const;

/**
 * Algo que o robô quer fazer e precisa do "sim" do dono antes (regra do doc, seção 10):
 * escrever na agenda, ou rodar algo na máquina dele.
 */
export const Proposal = z.object({
  id: z.string(),
  kind: z.enum(['event', 'command']),
  title: z.string(),
  /** Só em 'event'. */
  start: epochMs.optional(),
  end: epochMs.optional(),
  /** Só em 'command': a linha que vai rodar, exatamente como foi proposta. */
  comando: z.string().optional(),
  status: z.enum(PROPOSAL_STATUS),
  error: z.string().optional(),
});

export const MESSAGE_KINDS = ['reply', 'proactive', 'reminder'] as const;

/** Por onde a mensagem do dono chegou. */
export const MESSAGE_VIA = ['text', 'voice', 'siri'] as const;
export type MessageVia = (typeof MESSAGE_VIA)[number];

/** Foto mandada pelo app. O arquivo fica no servidor; `desc` é o que o modelo de visão viu nela. */
export const ChatPhoto = z.object({
  id: z.string().uuid(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  /** Descrição feita pelo modelo de visão — é por ela que o cérebro (só texto) "enxerga" a foto. */
  desc: z.string().max(3000).optional(),
});

export const ChatMessage = z.object({
  id: z.string(),
  from: z.enum(['user', 'robot']),
  text: z.string(),
  ts: epochMs,
  kind: z.enum(MESSAGE_KINDS).optional(),
  via: z.enum(MESSAGE_VIA).optional(),
  face: z.enum(FACES).optional(),
  proposal: Proposal.optional(),
  photo: ChatPhoto.optional(),
});

export const RobotView = z.object({
  /** O robô físico está conectado ao servidor. */
  online: z.boolean(),
  /** Expressão que a tela do robô está mostrando agora (null se offline). */
  face: z.enum(FACES).nullable(),
  thinking: z.boolean(),
  /** 0 = não está esperando resposta */
  waiting_since: epochMs,
});

/* ───────────── Webapp → Servidor ───────────── */

export const Say = z.object({
  t: z.literal('say'),
  ts: epochMs,
  text: z.string().trim().min(1).max(2000),
});

export const Confirm = z.object({
  t: z.literal('confirm'),
  ts: epochMs,
  proposal_id: z.string(),
  ok: z.boolean(),
});

export const AppPing = z.object({ t: z.literal('ping'), ts: epochMs });

/** O app avisa quando fica visível ou vai para segundo plano: sem ninguém olhando, a resposta vira push. */
export const Presence = z.object({ t: z.literal('presence'), ts: epochMs, visible: z.boolean() });

export const AppClientMessage = z.discriminatedUnion('t', [Say, Confirm, AppPing, Presence]);

/* ───────────── Servidor → Webapp ───────────── */

export const Snapshot = z.object({
  t: z.literal('snapshot'),
  ts: epochMs,
  messages: z.array(ChatMessage),
  robot: RobotView,
  agenda: z.array(AgendaItem),
});

/** Mensagem nova ou atualizada (mesmo id = substitui, ex.: proposta confirmada). */
export const MessageUpsert = z.object({
  t: z.literal('message'),
  ts: epochMs,
  message: ChatMessage,
});

export const RobotUpdate = z.object({ t: z.literal('robot'), ts: epochMs, robot: RobotView });

export const AppAgenda = z.object({ t: z.literal('agenda'), ts: epochMs, items: z.array(AgendaItem) });

export const AppPong = z.object({ t: z.literal('pong'), ts: epochMs });

export const AppServerMessage = z.discriminatedUnion('t', [Snapshot, MessageUpsert, RobotUpdate, AppAgenda, AppPong]);

export type Proposal = z.infer<typeof Proposal>;
export type ChatMessage = z.infer<typeof ChatMessage>;
export type ChatPhoto = z.infer<typeof ChatPhoto>;
export type RobotView = z.infer<typeof RobotView>;
export type AppClientMessage = z.infer<typeof AppClientMessage>;
export type AppServerMessage = z.infer<typeof AppServerMessage>;
