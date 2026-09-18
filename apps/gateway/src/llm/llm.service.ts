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

interface Target {
  client: OpenAI;
  model: string;
  /** "provedor/modelo", para log e castigo */
  label: string;
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

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    const make = (baseURL: string, apiKey: string) =>
      new OpenAI({ apiKey, baseURL, timeout: ATTEMPT_TIMEOUT_MS, maxRetries: 0 });
    const host = (url: string) => new URL(url).hostname.replace(/^(api|integrate)\./, '');

    if (cfg.LLM_API_KEY) {
      const client = make(cfg.LLM_BASE_URL, cfg.LLM_API_KEY);
      this.targets.push({ client, model: cfg.LLM_MODEL, label: `${host(cfg.LLM_BASE_URL)}/${cfg.LLM_MODEL}` });
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

  async complete(messages: ChatCompletionMessageParam[], tools?: ChatCompletionTool[]): Promise<ChatCompletionMessage> {
    if (!this.targets.length) throw new Error('LLM desligado (sem chave)');
    const now = Date.now();
    // Os que estão bem primeiro, na ordem configurada; os de castigo ficam de último recurso.
    const order = [...this.targets].sort(
      (a, b) => Number(this.isPenalized(a.label, now)) - Number(this.isPenalized(b.label, now)),
    );

    let lastError: unknown;
    for (const t of order) {
      const started = Date.now();
      try {
        const res = await t.client.chat.completions.create({
          model: t.model,
          messages,
          ...(tools?.length ? { tools, tool_choice: 'auto' as const } : {}),
          temperature: 0.6,
          max_tokens: 800,
        });
        const msg = res.choices[0]?.message;
        if (!msg) throw new Error('resposta vazia');
        this.penalizedUntil.delete(t.label);
        this.log.debug(`${t.label} respondeu em ${Date.now() - started} ms`);
        return msg;
      } catch (err) {
        lastError = err;
        this.penalizedUntil.set(t.label, Date.now() + PENALTY_MS);
        this.log.warn(`${t.label} falhou em ${Date.now() - started} ms (${(err as Error).message}) — tentando o próximo`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('nenhum modelo respondeu');
  }

  private isPenalized(label: string, now: number): boolean {
    return (this.penalizedUntil.get(label) ?? 0) > now;
  }
}
