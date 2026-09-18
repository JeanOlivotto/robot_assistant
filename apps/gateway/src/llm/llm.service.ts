import { Inject, Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/**
 * Qualquer API compatível com OpenAI Chat Completions — hoje a NVIDIA (build.nvidia.com).
 * Trocar de provedor = mudar LLM_BASE_URL / LLM_MODEL no .env.
 */
@Injectable()
export class LlmService {
  private readonly log = new Logger(LlmService.name);
  private readonly client: OpenAI | null;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.client = cfg.LLM_API_KEY
      ? new OpenAI({ apiKey: cfg.LLM_API_KEY, baseURL: cfg.LLM_BASE_URL, timeout: 30_000, maxRetries: 1 })
      : null;
    if (!this.client) this.log.warn('LLM_API_KEY vazio — o robô responde sem inteligência');
    else this.log.log(`LLM: ${cfg.LLM_MODEL} em ${cfg.LLM_BASE_URL}`);
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async complete(messages: ChatCompletionMessageParam[], tools?: ChatCompletionTool[]): Promise<ChatCompletionMessage> {
    if (!this.client) throw new Error('LLM desligado (LLM_API_KEY vazio)');
    const started = Date.now();
    const res = await this.client.chat.completions.create({
      model: this.cfg.LLM_MODEL,
      messages,
      ...(tools?.length ? { tools, tool_choice: 'auto' as const } : {}),
      temperature: 0.6,
      max_tokens: 800,
    });
    const msg = res.choices[0]?.message;
    if (!msg) throw new Error('resposta vazia do LLM');
    this.log.debug(`LLM respondeu em ${Date.now() - started} ms`);
    return msg;
  }
}
