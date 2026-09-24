import { Inject, Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/** Quanto esperar cada modelo antes de tentar o próximo (a Siri desiste perto de 1 min). */
const ATTEMPT_TIMEOUT_MS = 15_000;
/** Modelo que falhou fica de lado por um tempo, para a próxima mensagem não esperar à toa. */
const PENALTY_MS = 5 * 60_000;
/*
 * Todos os modelos rápidos (Groq) no limite por minuto: se um deles libera em até isto, vale mais
 * esperar por ele (o Groq costuma pedir ~15 s) do que cair na reserva lenta — que numa ligação
 * levava 30 s até desistir.
 */
const RATE_WAIT_MAX_MS = 20_000;

interface Target {
  client: OpenAI;
  model: string;
  /** "provedor/modelo", para log e castigo */
  label: string;
  /** No provedor principal (rápido). A reserva é mais lenta: só entra quando esperar não resolve. */
  fast?: boolean;
}

/**
 * Qualquer API compatível com OpenAI Chat Completions. Principal (hoje Groq) e reserva
 * (hoje NVIDIA) em ordem: se um modelo demora ou falha, tenta o próximo.
 */
@Injectable()
export class LlmService {
  private readonly log = new Logger(LlmService.name);
  private readonly targets: Target[] = [];
  private readonly penalizedUntil = new Map<string, number>();
  /** Modelos rápidos no limite por minuto, e quando liberam. */
  private readonly rateLimitedUntil = new Map<string, number>();

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    const make = (baseURL: string, apiKey: string) =>
      new OpenAI({ apiKey, baseURL, timeout: ATTEMPT_TIMEOUT_MS, maxRetries: 0 });
    const host = (url: string) => new URL(url).hostname.replace(/^(api|integrate)\./, '');

    if (cfg.LLM_API_KEY) {
      const client = make(cfg.LLM_BASE_URL, cfg.LLM_API_KEY);
      for (const model of [cfg.LLM_MODEL, ...cfg.LLM_EXTRA_MODELS.split(',')].map((m) => m.trim()).filter(Boolean)) {
        const label = `${host(cfg.LLM_BASE_URL)}/${model}`;
        if (!this.targets.some((t) => t.label === label)) this.targets.push({ client, model, label, fast: true });
      }
    }
    const fallbackKey = cfg.LLM_FALLBACK_API_KEY || cfg.LLM_API_KEY;
    const fallbackUrl = cfg.LLM_FALLBACK_API_KEY ? cfg.LLM_FALLBACK_BASE_URL : cfg.LLM_BASE_URL;
    if (fallbackKey) {
      const client = make(fallbackUrl, fallbackKey);
      for (const model of cfg.LLM_FALLBACK_MODELS.split(',').map((m) => m.trim()).filter(Boolean)) {
        const label = `${host(fallbackUrl)}/${model}`;
        if (!this.targets.some((t) => t.label === label)) this.targets.push({ client, model, label });
      }
    }

    if (!this.targets.length) this.log.warn('Nenhuma chave de LLM — o robô responde sem inteligência');
    else this.log.log(`LLM: ${this.targets.map((t) => t.label).join(' → ')}`);
  }

  get enabled(): boolean {
    return this.targets.length > 0;
  }

  async complete(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
    opts?: {
      maxTokens?: number;
      temperature?: number;
      /** Pensar pouco antes de responder (ligação): o gpt-oss raciocina bem menos e responde mais rápido. */
      quick?: boolean;
    },
  ): Promise<ChatCompletionMessage> {
    if (!this.targets.length) throw new Error('LLM desligado (sem chave)');
    const now = Date.now();
    // Os que estão bem primeiro, na ordem configurada; os de castigo ficam de último recurso.
    const order = [...this.targets].sort(
      (a, b) => Number(this.isPenalized(a.label, now)) - Number(this.isPenalized(b.label, now)),
    );

    const attempt = async (t: Target): Promise<ChatCompletionMessage> => {
      const started = Date.now();
      try {
        const res = await t.client.chat.completions.create({
          model: t.model,
          messages,
          ...(tools?.length ? { tools, tool_choice: 'auto' as const } : {}),
          temperature: opts?.temperature ?? 0.6,
          max_tokens: opts?.maxTokens ?? 800,
          // Só o gpt-oss entende "esforço de raciocínio"; os outros modelos recusariam o campo.
          ...(opts?.quick && /gpt-oss/.test(t.model) ? { reasoning_effort: 'low' as const } : {}),
        });
        const msg = res.choices[0]?.message;
        if (!msg) throw new Error('resposta vazia');
        this.penalizedUntil.delete(t.label);
        this.rateLimitedUntil.delete(t.label);
        this.log.debug(`${t.label} respondeu em ${Date.now() - started} ms (${res.usage?.prompt_tokens ?? '?'} + ${res.usage?.completion_tokens ?? '?'} tokens)`);
        return msg;
      } catch (err) {
        const penalty = penaltyFor(err);
        this.penalizedUntil.set(t.label, Date.now() + penalty);
        if (t.fast && penalty < PENALTY_MS) this.rateLimitedUntil.set(t.label, Date.now() + penalty);
        this.log.warn(`${t.label} falhou em ${Date.now() - started} ms (${(err as Error).message}) — tentando o próximo`);
        throw err;
      }
    };

    let lastError: unknown;
    let waited = false;
    for (const t of order) {
      // Antes de ir para a reserva lenta: algum rápido libera logo? Espera por ele (uma vez só).
      if (!t.fast && !waited) {
        const soon = this.soonestFast();
        if (soon) {
          waited = true;
          this.log.log(`Todos os rápidos no limite — esperando ${Math.round(soon.wait / 1000)} s pelo ${soon.target.label}`);
          await new Promise((r) => setTimeout(r, soon.wait));
          try {
            return await attempt(soon.target);
          } catch (err) {
            lastError = err;
          }
        }
      }
      try {
        return await attempt(t);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('nenhum modelo respondeu');
  }

  /** O modelo rápido que sai do limite por minuto mais cedo, se for em até RATE_WAIT_MAX_MS. */
  private soonestFast(): { target: Target; wait: number } | null {
    const now = Date.now();
    let best: { target: Target; wait: number } | null = null;
    for (const t of this.targets) {
      const until = this.rateLimitedUntil.get(t.label);
      if (!t.fast || !until) continue;
      const wait = Math.max(0, until - now);
      if (wait <= RATE_WAIT_MAX_MS && (!best || wait < best.wait)) best = { target: t, wait };
    }
    return best;
  }

  private isPenalized(label: string, now: number): boolean {
    return (this.penalizedUntil.get(label) ?? 0) > now;
  }
}

/**
 * Quanto tempo o modelo que falhou fica de lado. Limite por minuto (429) passa rápido — o próprio
 * provedor diz quanto esperar ("try again in 14.8s") —, então não vale tirá-lo da fila por 5 min.
 */
export function penaltyFor(err: unknown): number {
  const e = err as { status?: number; message?: string };
  if (e?.status === 429 || /rate limit/i.test(e?.message ?? '')) {
    const s = /try again in ([\d.]+)\s*s/i.exec(e?.message ?? '');
    return s ? Math.ceil(Number(s[1]) * 1000) + 1000 : 60_000;
  }
  return PENALTY_MS;
}
