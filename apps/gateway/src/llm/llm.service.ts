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
/*
 * Quanto esperar, no total, pelos rápidos numa mensagem. O Groq às vezes libera e pede de novo
 * ("try again in 30ms"): vale insistir nele dentro disto em vez de ir para a reserva.
 */
const RATE_WAIT_BUDGET_MS = 25_000;

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
      /**
       * Começa pela reserva (NVIDIA) e só depois vai para o principal. Para o que não tem pressa e
       * não pode comer a cota diária do Groq — ex.: terceiros conversando com ele no WhatsApp.
       */
      reservaPrimeiro?: boolean;
    },
  ): Promise<ChatCompletionMessage> {
    if (!this.targets.length) throw new Error('LLM desligado (sem chave)');
    const now = Date.now();
    // Os que estão bem primeiro, na ordem configurada; os de castigo ficam de último recurso.
    const order = [...this.targets].sort(
      (a, b) =>
        Number(this.isPenalized(a.label, now)) - Number(this.isPenalized(b.label, now)) ||
        (opts?.reservaPrimeiro ? Number(!!a.fast) - Number(!!b.fast) : 0),
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
        if (penalty) this.penalizedUntil.set(t.label, Date.now() + penalty);
        if (t.fast && penalty && penalty < PENALTY_MS) this.rateLimitedUntil.set(t.label, Date.now() + penalty);
        else this.rateLimitedUntil.delete(t.label);
        this.log.warn(`${t.label} falhou em ${Date.now() - started} ms (${(err as Error).message}) — tentando o próximo`);
        throw err;
      }
    };

    let lastError: unknown;
    // Com a reserva na frente, não faz sentido esperar pelo Groq antes dela.
    let esperou = opts?.reservaPrimeiro ? RATE_WAIT_BUDGET_MS : 0;
    // Reserva que deu timeout há pouco: tentar de novo custa 15 s à toa. Fica para o fim, se nada mais der.
    const deixadas: Target[] = [];
    for (const t of order) {
      if (!t.fast) {
        // Antes da reserva lenta: algum rápido libera logo? Espera por ele — e de novo, se ele pedir
        // mais um pouco, enquanto couber no orçamento.
        for (let vez = 0; vez < 5; vez++) {
          const soon = this.soonestFast();
          if (!soon || esperou + soon.wait > RATE_WAIT_BUDGET_MS) break;
          esperou += soon.wait;
          this.log.log(`Todos os rápidos no limite — esperando ${(soon.wait / 1000).toFixed(1)} s pelo ${soon.target.label}`);
          await new Promise((r) => setTimeout(r, soon.wait));
          try {
            return await attempt(soon.target);
          } catch (err) {
            lastError = err;
          }
        }
        if (this.isPenalized(t.label, Date.now())) {
          deixadas.push(t);
          continue;
        }
      }
      try {
        return await attempt(t);
      } catch (err) {
        lastError = err;
      }
    }
    for (const t of deixadas) {
      try {
        return await attempt(t);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('nenhum modelo respondeu');
  }

  /**
   * Pesquisa na internet: o gpt-oss do Groq tem busca embutida (browser_search), sem chave nova. Chamada
   * à parte, no 20b primeiro — o limite por minuto dele é separado, o do modelo principal fica livre.
   * Devolve o que achou, curto, com as fontes.
   */
  async pesquisar(pergunta: string): Promise<string> {
    const alvos = this.targets
      .filter((t) => t.fast && /gpt-oss/.test(t.model) && !/safeguard/.test(t.model))
      .sort((a, b) => Number(/120b/.test(a.model)) - Number(/120b/.test(b.model)));
    if (!alvos.length) throw new Error('a busca na internet precisa do gpt-oss no Groq');
    let erro: unknown;
    for (const t of alvos) {
      const started = Date.now();
      try {
        const res = await t.client.chat.completions.create({
          model: t.model,
          messages: [
            {
              role: 'system',
              content:
                'Pesquise na internet e responda em português do Brasil, curto e só com fatos: o que achou (números, datas, ' +
                'versões, nomes) e, no fim, as fontes (só o site, ex.: nodejs.org). Não achou ou as fontes discordam: diga isso.',
            },
            { role: 'user', content: pergunta },
          ],
          // Ferramenta do próprio Groq (não é function calling): o SDK não conhece o tipo.
          tools: [{ type: 'browser_search' } as unknown as ChatCompletionTool],
          temperature: 0.2,
          max_tokens: 1200,
        });
        const texto = limparCitacoes(res.choices[0]?.message?.content ?? '');
        this.log.debug(`${t.label} pesquisou em ${Date.now() - started} ms (${res.usage?.total_tokens ?? '?'} tokens)`);
        if (texto) return texto;
        erro = new Error('a busca voltou vazia');
      } catch (err) {
        erro = err;
        this.log.warn(`${t.label} não conseguiu pesquisar em ${Date.now() - started} ms (${(err as Error).message})`);
      }
    }
    throw erro instanceof Error ? erro : new Error('a busca falhou');
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
 * Pedido recusado (400: o modelo errou o formato de uma ferramenta nesta mensagem) é coisa daquela
 * mensagem, não do modelo: não fica de castigo.
 */
export function penaltyFor(err: unknown): number {
  const e = err as { status?: number; message?: string };
  if (e?.status === 400) return 0;
  if (e?.status === 429 || /rate limit/i.test(e?.message ?? '')) {
    const s = /try again in ([\d.]+)\s*s/i.exec(e?.message ?? '');
    return s ? Math.ceil(Number(s[1]) * 1000) + 1000 : 60_000;
  }
  return PENALTY_MS;
}

/** Tira as marcas de citação do gpt-oss ("【1†L6-L8】"): na tela e na voz, são só ruído. */
export function limparCitacoes(texto: string): string {
  return texto
    .replace(/【[^】]*】/g, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
