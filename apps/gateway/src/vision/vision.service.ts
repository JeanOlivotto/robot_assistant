import { Inject, Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

const ATTEMPT_TIMEOUT_MS = 45_000;

/**
 * Os olhos do robô: descreve uma foto em texto. O cérebro principal só lê texto, então a foto
 * entra na conversa pela descrição — e ela fica guardada, para ele lembrar da foto depois.
 */
@Injectable()
export class VisionService {
  private readonly log = new Logger(VisionService.name);
  private readonly client: OpenAI | null;
  private readonly models: string[];

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    const key = cfg.VISION_API_KEY || cfg.LLM_FALLBACK_API_KEY || cfg.LLM_API_KEY;
    const baseURL = cfg.VISION_BASE_URL || (cfg.LLM_FALLBACK_API_KEY ? cfg.LLM_FALLBACK_BASE_URL : cfg.LLM_BASE_URL);
    this.models = cfg.VISION_MODELS.split(',').map((m) => m.trim()).filter(Boolean);
    this.client = key && this.models.length ? new OpenAI({ apiKey: key, baseURL, timeout: ATTEMPT_TIMEOUT_MS, maxRetries: 0 }) : null;
    if (!this.client) this.log.warn('Sem chave para visão — as fotos chegam, mas o robô não enxerga');
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** Descrição da foto, ou null se nenhum modelo conseguiu. `pedido` é a legenda que o dono escreveu. */
  async describe(image: Buffer, mime: string, pedido = ''): Promise<string | null> {
    if (!this.client) return null;
    const owner = this.cfg.OWNER_NAME || 'o dono';
    const prompt =
      `${owner} mandou esta foto para um assistente que NÃO consegue vê-la. Descreva para ele, em português:\n` +
      '- o que aparece e onde parece ser;\n' +
      '- TODO texto legível, transcrito fielmente (nomes, números, datas, horários, valores, endereços);\n' +
      '- pessoas: aparência e o que fazem, sem tentar dizer quem são.\n' +
      (pedido ? `${owner} escreveu junto: "${pedido}". Dê atenção ao que ajuda a responder isso.\n` : '') +
      'Seja objetivo, sem opinião nem enfeite. Se algo estiver ilegível, diga que está ilegível — não adivinhe.';
    const url = `data:${mime};base64,${image.toString('base64')}`;

    for (const model of this.models) {
      const started = Date.now();
      try {
        const res = await this.client.chat.completions.create({
          model,
          max_tokens: 700,
          temperature: 0.2,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url } }] }],
        });
        const text = (res.choices[0]?.message?.content ?? '').trim();
        if (text) {
          this.log.log(`Foto descrita por ${model} em ${Date.now() - started} ms`);
          return text.slice(0, 3000);
        }
      } catch (err) {
        this.log.warn(`${model} não descreveu a foto (${(err as Error).message}) — tentando o próximo`);
      }
    }
    return null;
  }
}
