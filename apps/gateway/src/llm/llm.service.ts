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

/**
 * Qualquer API compatível com OpenAI Chat Completions — hoje a NVIDIA (build.nvidia.com).
 * A fila gratuita da NVIDIA oscila por modelo, então há uma lista de reserva em ordem.
 */
@Injectable()
export class LlmService {
  private readonly log = new Logger(LlmService.name);
  private readonly client: OpenAI | null;
  private readonly models: string[];
  private readonly penalizedUntil = new Map<string, number>();

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.models = [cfg.LLM_MODEL, ...cfg.LLM_FALLBACK_MODELS.split(',').map((m) => m.trim())].filter(
      (m, i, all) => m && all.indexOf(m) === i,
    );
    this.client = cfg.LLM_API_KEY
      ? new OpenAI({ apiKey: cfg.LLM_API_KEY, baseURL: cfg.LLM_BASE_URL, timeout: ATTEMPT_TIMEOUT_MS, maxRetries: 0 })
      : null;
    if (!this.client) this.log.warn('LLM_API_KEY vazio — o robô responde sem inteligência');
    else this.log.log(`LLM: ${this.models.join(' → ')} em ${cfg.LLM_BASE_URL}`);
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async complete(messages: ChatCompletionMessageParam[], tools?: ChatCompletionTool[]): Promise<ChatCompletionMessage> {
    if (!this.client) throw new Error('LLM desligado (LLM_API_KEY vazio)');
    const now = Date.now();
    // Os que estão bem primeiro, na ordem configurada; os de castigo ficam de último recurso.
    const order = [...this.models].sort((a, b) => Number(this.isPenalized(a, now)) - Number(this.isPenalized(b, now)));

    let lastError: unknown;
    for (const model of order) {
      const started = Date.now();
      try {
        const res = await this.client.chat.completions.create({
          model,
          messages,
          ...(tools?.length ? { tools, tool_choice: 'auto' as const } : {}),
          temperature: 0.6,
          max_tokens: 800,
        });
        const msg = res.choices[0]?.message;
        if (!msg) throw new Error('resposta vazia');
        this.penalizedUntil.delete(model);
        this.log.debug(`${model} respondeu em ${Date.now() - started} ms`);
        return msg;
      } catch (err) {
        lastError = err;
        this.penalizedUntil.set(model, Date.now() + PENALTY_MS);
        this.log.warn(`${model} falhou em ${Date.now() - started} ms (${(err as Error).message}) — tentando o próximo`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('nenhum modelo respondeu');
  }

  private isPenalized(model: string, now: number): boolean {
    return (this.penalizedUntil.get(model) ?? 0) > now;
  }
}
