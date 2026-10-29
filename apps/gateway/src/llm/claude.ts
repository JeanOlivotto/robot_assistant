import type Anthropic from '@anthropic-ai/sdk';
import type {
  ChatCompletionContentPart,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

/*
 * O resto do gateway fala o formato da OpenAI (Chat Completions). Aqui ele vira o da Anthropic e
 * volta: quem chama o LlmService não precisa saber que do outro lado está o Claude.
 */

type Bloco = Anthropic.ContentBlockParam;

/**
 * Resposta do Claude que chamou ferramenta, inteira (com o raciocínio), pela id da primeira chamada.
 * O cérebro remonta a mensagem só com texto e tool_calls; na volta, a original vai no lugar dela.
 */
export class RespostasGuardadas {
  private readonly mapa = new Map<string, Bloco[]>();
  constructor(private readonly max = 200) {}

  guardar(res: Anthropic.Message): void {
    const primeira = res.content.find((b) => b.type === 'tool_use');
    if (!primeira) return;
    this.mapa.set(primeira.id, res.content as unknown as Bloco[]);
    while (this.mapa.size > this.max) this.mapa.delete(this.mapa.keys().next().value!);
  }

  pegar(id: string | undefined): Bloco[] | undefined {
    return id ? this.mapa.get(id) : undefined;
  }
}

/** As mensagens no formato da Anthropic: o system de cima vira o `system`; os do meio, aviso no turno do usuário. */
export function paraClaude(
  messages: ChatCompletionMessageParam[],
  guardadas?: RespostasGuardadas,
): { system: string; messages: Anthropic.MessageParam[] } {
  const system: string[] = [];
  const saida: Anthropic.MessageParam[] = [];
  const doUsuario = (blocos: Bloco[]) => {
    const ultima = saida.at(-1);
    if (ultima?.role === 'user' && Array.isArray(ultima.content)) ultima.content.push(...blocos);
    else saida.push({ role: 'user', content: blocos });
  };

  for (const m of messages) {
    switch (m.role) {
      case 'system':
      case 'developer':
        if (!saida.length) system.push(texto(m.content));
        else doUsuario([{ type: 'text', text: `[instrução interna do sistema] ${texto(m.content)}` }]);
        break;
      case 'user': {
        const blocos = typeof m.content === 'string' ? [] : m.content.flatMap(parte);
        if (typeof m.content === 'string' && m.content.trim()) blocos.push({ type: 'text', text: m.content });
        doUsuario(blocos.length ? blocos : [{ type: 'text', text: '...' }]);
        break;
      }
      case 'assistant': {
        const calls = (m.tool_calls ?? []).filter((c) => c.type === 'function');
        const original = guardadas?.pegar(calls[0]?.id);
        if (original) {
          saida.push({ role: 'assistant', content: original });
          break;
        }
        const blocos: Bloco[] = [];
        const t = texto(m.content ?? '');
        if (t.trim()) blocos.push({ type: 'text', text: t });
        for (const c of calls) blocos.push({ type: 'tool_use', id: c.id, name: c.function.name, input: argumentos(c.function.arguments) });
        saida.push({ role: 'assistant', content: blocos.length ? blocos : [{ type: 'text', text: '...' }] });
        break;
      }
      case 'tool':
        doUsuario([{ type: 'tool_result', tool_use_id: m.tool_call_id, content: texto(m.content) || '(vazio)' }]);
        break;
      default:
        break;
    }
  }

  // A conversa tem de começar e terminar no usuário (o Claude não aceita continuar uma fala dele).
  if (saida[0]?.role === 'assistant') saida.unshift({ role: 'user', content: '(conversa em andamento)' });
  if (!saida.length || saida.at(-1)!.role === 'assistant') saida.push({ role: 'user', content: '(continue)' });
  return { system: system.join('\n\n'), messages: saida };
}

/** As ferramentas no formato da Anthropic; a última marca o fim do cache (elas mudam pouco entre chamadas). */
export function ferramentasParaClaude(tools: ChatCompletionTool[] | undefined): Anthropic.Tool[] {
  const delas: Anthropic.Tool[] = (tools ?? [])
    .filter((t) => t.type === 'function')
    .map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: (t.function.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema,
    }));
  if (delas.length) delas[delas.length - 1] = { ...delas.at(-1)!, cache_control: { type: 'ephemeral' } };
  return delas;
}

/** A resposta do Claude no formato da OpenAI. Recusa vira erro: o LlmService tenta o próximo modelo. */
export function deClaude(res: Anthropic.Message): ChatCompletionMessage {
  if (res.stop_reason === 'refusal') throw new Error(`o Claude recusou (${res.stop_details?.category ?? 'sem categoria'})`);
  const content = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const calls = res.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  return { role: 'assistant', content, refusal: null, ...(calls.length ? { tool_calls: calls } : {}) };
}

function texto(content: string | Iterable<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return [...content].map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('\n');
}

const IMAGENS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

function parte(p: ChatCompletionContentPart): Bloco[] {
  if (p.type === 'text') return p.text.trim() ? [{ type: 'text', text: p.text }] : [];
  if (p.type !== 'image_url') return [];
  const data = /^data:([^;]+);base64,(.+)$/s.exec(p.image_url.url);
  if (!data) return [{ type: 'image', source: { type: 'url', url: p.image_url.url } }];
  const mime = IMAGENS.find((m) => m === data[1]) ?? 'image/jpeg';
  return [{ type: 'image', source: { type: 'base64', media_type: mime, data: data[2]! } }];
}

/** Os argumentos vêm em JSON (string); malformado vira objeto vazio, e a ferramenta reclama do que faltou. */
function argumentos(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
