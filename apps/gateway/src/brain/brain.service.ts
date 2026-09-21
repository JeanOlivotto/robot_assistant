import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { ChatMessage, Face } from '@robo/protocol';
import { CalendarService } from '../calendar/calendar.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { LlmService } from '../llm/llm.service.js';
import { MemoryService } from '../memory/memory.service.js';
import { describeAgenda, splitEmotion, systemPrompt } from './prompts.js';
import { DIAS, resolveDay, resolveWhen } from './resolve-date.js';

export interface ProposalDraft {
  title: string;
  start: Date;
  end: Date;
}

export interface BrainReply {
  text: string;
  face: Face;
  proposal?: ProposalDraft;
}

export type ComposeKind = 'morning' | 'evening' | 'attention';

/** O que o robô sabe da situação na hora de decidir se fala ou fica quieto. */
export interface JudgeContext {
  /** Há quantas horas o dono não diz nada. */
  idleHours: number;
  /** A última coisa que o robô disse por conta própria hoje (vazio = nenhuma). */
  lastSpontaneous: string;
  /** Quantas vezes ele já puxou conversa hoje. */
  spokenToday: number;
  /** Já trocaram alguma palavra hoje? */
  talkedToday: boolean;
}

export interface Judgement {
  speak: boolean;
  text: string;
  face: Face;
  /** Por que decidiu assim — vai para o log, nunca para o dono. */
  reason: string;
}

const HISTORY = 16;
/** Resposta falada é curta de propósito: menos texto = o robô começa a falar mais cedo. */
const SPOKEN_MAX_TOKENS = 220;
/** O juízo é uma decisão curta, não um texto longo. */
const JUDGE_MAX_TOKENS = 260;
const MAX_STEPS = 4;
const DAY_MS = 24 * 3600_000;

/* Intents da seção 10 do doc, como ferramentas de function calling. */
const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'consultar_agenda',
      description: 'Lista os compromissos do dono num período. Use sempre que perguntarem da agenda.',
      parameters: {
        type: 'object',
        properties: {
          periodo: { type: 'string', enum: ['hoje', 'amanha', 'semana', 'data'] },
          data: { type: 'string', description: 'DD/MM — só quando periodo = "data"' },
        },
        required: ['periodo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propor_evento',
      description:
        'Prepara um compromisso novo; o dono confirma num botão antes de ir para a agenda. ' +
        'NÃO calcule datas: passe o dia como o dono falou.',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'curto, ex.: "Reunião com Fábio"' },
          dia: { type: 'string', enum: [...DIAS] },
          data: { type: 'string', description: 'DD/MM ou DD/MM/AAAA — só quando dia = "data"' },
          hora: { type: 'string', description: 'HH:MM (24h)' },
          duracao_min: { type: 'integer', description: 'duração em minutos; padrão 60' },
        },
        required: ['titulo', 'dia', 'hora'],
      },
    },
  },
];

/** O "cérebro": LLM + ferramentas. É o mesmo que a voz vai usar na Fase 1. */
@Injectable()
export class BrainService {
  private readonly log = new Logger(BrainService.name);
  private readonly dayFmt: Intl.DateTimeFormat;
  private readonly timeFmt: Intl.DateTimeFormat;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly llm: LlmService,
    private readonly calendar: CalendarService,
    private readonly memory: MemoryService,
  ) {
    this.dayFmt = new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      timeZone: cfg.TZ_NAME,
    });
    this.timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: cfg.TZ_NAME });
  }

  /** Responde à conversa (a última mensagem do histórico é a do dono). */
  async reply(history: ChatMessage[], opts: { spoken?: boolean } = {}): Promise<BrainReply> {
    if (!this.llm.enabled) {
      return { text: 'Meu cérebro ainda está desligado... falta a chave da IA no servidor (LLM_API_KEY).', face: 'sad' };
    }
    const now = new Date();
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: systemPrompt({ ...this.promptContext(now), spoken: opts.spoken, todayAgenda: await this.todayAgenda(now) }),
      },
      ...toLlmHistory(history.slice(-HISTORY), this.cfg.TZ_NAME),
    ];

    let proposal: ProposalDraft | undefined;
    for (let step = 0; step < MAX_STEPS; step++) {
      const msg = await this.llm.complete(messages, TOOLS, opts.spoken ? { maxTokens: SPOKEN_MAX_TOKENS } : undefined);
      const calls = (msg.tool_calls ?? []).filter((c) => c.type === 'function');
      if (!calls.length) {
        const { text, face } = splitEmotion(msg.content ?? '');
        return { text: text || '...', face, proposal };
      }
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
      for (const call of calls) {
        const out = await this.runTool(call.function.name, call.function.arguments, now);
        this.log.log(`ferramenta ${call.function.name}(${call.function.arguments}) → ${out.result.split('\n')[0]}`);
        if (out.proposal) proposal = out.proposal;
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.result });
      }
    }
    return { text: 'Me enrolei aqui... pode falar de outro jeito?', face: 'thinking', proposal };
  }

  /** Mensagens que o robô manda por conta própria. */
  async compose(kind: ComposeKind, history: ChatMessage[], hoursIdle = 0): Promise<{ text: string; face: Face }> {
    const now = new Date();
    const { instruction, fallback } = await this.composeInstruction(kind, now, hoursIdle);
    if (!this.llm.enabled) return fallback;
    try {
      const owner = this.cfg.OWNER_NAME || 'o dono';
      const msg = await this.llm.complete([
        { role: 'system', content: systemPrompt(this.promptContext(now)) },
        ...toLlmHistory(history.slice(-6), this.cfg.TZ_NAME),
        { role: 'user', content: `[instrução interna do sistema — não é ${owner} falando] ${instruction}` },
      ]);
      const out = splitEmotion(msg.content ?? '');
      return out.text ? out : fallback;
    } catch (err) {
      this.log.warn(`compose(${kind}) falhou, usando texto padrão: ${(err as Error).message}`);
      return fallback;
    }
  }

  /**
   * Decide sozinho se vale puxar conversa agora — e, se valer, o que dizer.
   * Quem chama já cuidou dos limites (hora, teto do dia, intervalo): aqui é só o juízo.
   */
  async judge(history: ChatMessage[], ctx: JudgeContext): Promise<Judgement | null> {
    if (!this.llm.enabled) return null;
    const now = new Date();
    const owner = this.cfg.OWNER_NAME || 'o dono';
    const agenda = await this.todayAgenda(now);
    const vezes = ctx.spokenToday === 0 ? 'nenhuma vez' : ctx.spokenToday === 1 ? 'uma vez' : `${ctx.spokenToday} vezes`;

    const situacao = [
      `- ${ctx.talkedToday ? 'vocês já se falaram hoje' : 'vocês ainda não se falaram hoje'}`,
      `- faz ${ctx.idleHours < 1 ? 'menos de uma hora' : `umas ${Math.round(ctx.idleHours)} horas`} que ${owner} não diz nada`,
      `- hoje você já puxou conversa ${vezes}`,
      ctx.lastSpontaneous ? `- a última coisa que você disse por conta própria foi: "${ctx.lastSpontaneous}"` : '',
      `- agenda de hoje:\n${agenda || '(agenda não configurada)'}`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const msg = await this.llm.complete(
        [
          { role: 'system', content: systemPrompt({ ...this.promptContext(now), todayAgenda: agenda }) },
          ...toLlmHistory(history.slice(-8), this.cfg.TZ_NAME),
          {
            role: 'user',
            content:
              `[instrução interna do sistema — não é ${owner} falando, e ele não vê esta mensagem]\n` +
              `Situação agora:\n${situacao}\n\n` +
              'Vale a pena falar com ele agora, ou é melhor ficar quieto?\n' +
              'Fale se você tem algo que justifique a interrupção: um compromisso chegando, um assunto que ficou ' +
              'no ar, algo que você reparou. Fique quieto se for só para encher linguiça, se já disse isso hoje ' +
              'ou se ele parece ocupado. Ficar quieto é resposta boa e deve ser a mais comum.\n' +
              'Responda SOMENTE com JSON: {"falar": true|false, "texto": "...", "motivo": "..."}. ' +
              'O texto é você falando, com a sua expressão entre colchetes no começo. ' +
              'Com "falar": false, deixe "texto" vazio.',
          },
        ],
        undefined,
        { maxTokens: JUDGE_MAX_TOKENS, temperature: 0.7 },
      );

      const out = parseJudgement(msg.content ?? '');
      if (!out) return null;
      if (!out.falar || !out.texto?.trim()) {
        return { speak: false, text: '', face: 'neutral', reason: out.motivo || 'preferiu ficar quieto' };
      }
      const { text, face } = splitEmotion(out.texto);
      if (!text) return null;
      return { speak: true, text, face, reason: out.motivo || '' };
    } catch (err) {
      this.log.warn(`judge() falhou: ${(err as Error).message}`);
      return null;
    }
  }

  /** Frase curtinha para o balão na tela do robô — "pensar alto". Null se o LLM não responder. */
  async thought(history: ChatMessage[]): Promise<{ text: string; face: Face } | null> {
    if (!this.llm.enabled) return null;
    const now = new Date();
    const today = resolveDay('hoje', undefined, now, this.cfg.TZ_NAME);
    const midnight = today.ok ? today.day.getTime() : now.getTime();
    const agenda = await this.calendar.query(now, new Date(midnight + DAY_MS)).catch(() => []);
    try {
      const msg = await this.llm.complete([
        { role: 'system', content: systemPrompt(this.promptContext(now)) },
        ...toLlmHistory(history.slice(-4), this.cfg.TZ_NAME),
        {
          role: 'user',
          content:
            '[instrução interna do sistema] Escreva UM pensamento seu, em voz alta, bem curto (no máximo 6 ' +
            'palavras), para aparecer num balão na sua telinha agora. Uma observação sobre a hora, sobre o que ' +
            'ainda falta no dia dele ou sobre o que você está achando disso. Seco, nada de fofura. ' +
            `Sem emoji, sem aspas. Resto da agenda hoje:\n${describeAgenda(agenda, this.cfg.TZ_NAME)}`,
        },
      ]);
      const out = splitEmotion(msg.content ?? '');
      const text = out.text.replace(/^["“']|["”']$/g, '').trim();
      return text ? { text, face: out.face } : null;
    } catch (err) {
      this.log.warn(`thought() falhou: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * A agenda de hoje entra pronta no prompt. Sem isso ele inventava compromisso no "bom dia":
   * o modelo não chama a ferramenta quando ninguém pergunta da agenda, mas comenta o dia assim mesmo.
   */
  private async todayAgenda(now: Date): Promise<string> {
    if (this.calendar.status.source === 'none') return '';
    const today = resolveDay('hoje', undefined, now, this.cfg.TZ_NAME);
    const midnight = today.ok ? today.day.getTime() : now.getTime();
    const list = await this.calendar.query(new Date(midnight), new Date(midnight + DAY_MS)).catch(() => []);
    return describeAgenda(list, this.cfg.TZ_NAME);
  }

  private promptContext(now: Date) {
    return {
      robotName: this.cfg.ROBOT_NAME,
      ownerName: this.cfg.OWNER_NAME,
      tz: this.cfg.TZ_NAME,
      now,
      canWrite: this.calendar.writable,
      memories: this.memory.summaries(),
    };
  }

  /** Puxa de volta um assunto antigo ("faz tempo que não falamos disso..."). Null se não houver o que lembrar. */
  async recall(history: ChatMessage[]): Promise<{ text: string; face: Face; memoryId: string } | null> {
    const m = this.memory.stale(this.cfg.MEMORY_RECALL_DAYS);
    if (!m || !this.llm.enabled) return null;
    const owner = this.cfg.OWNER_NAME || 'o dono';
    try {
      const msg = await this.llm.complete([
        { role: 'system', content: systemPrompt(this.promptContext(new Date())) },
        ...toLlmHistory(history.slice(-4), this.cfg.TZ_NAME),
        {
          role: 'user',
          content:
            `[instrução interna do sistema — não é ${owner} falando] Faz um tempo que vocês não falam sobre "${m.texto}". ` +
            'Puxe o assunto de volta numa frase curta, do jeito de quem reparou na ausência, e pergunte em que pé está. ' +
            'Sem drama e sem inventar detalhes que você não sabe.',
        },
      ]);
      const out = splitEmotion(msg.content ?? '');
      return out.text ? { text: out.text, face: out.face, memoryId: m.id } : null;
    } catch (err) {
      this.log.warn(`recall() falhou: ${(err as Error).message}`);
      return null;
    }
  }

  /** Aprende assuntos duradouros da conversa recente (memória de longo prazo). */
  async learn(history: ChatMessage[]): Promise<void> {
    await this.memory.learn(history);
  }

  private async runTool(name: string, rawArgs: string, now: Date): Promise<{ result: string; proposal?: ProposalDraft }> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
    } catch {
      return { result: 'erro: argumentos não são JSON válido' };
    }
    try {
      if (name === 'consultar_agenda') return { result: await this.consultarAgenda(args, now) };
      if (name === 'propor_evento') return await this.proporEvento(args, now);
      return { result: `erro: a ferramenta ${name} não existe` };
    } catch (err) {
      return { result: `erro: ${(err as Error).message}` };
    }
  }

  private async consultarAgenda(args: Record<string, unknown>, now: Date): Promise<string> {
    if (this.calendar.status.source === 'none') return 'a agenda ainda não está configurada no servidor';
    const periodo = String(args.periodo ?? 'hoje');
    let from: Date;
    let to: Date;
    if (periodo === 'semana') {
      const today = resolveDay('hoje', undefined, now, this.cfg.TZ_NAME);
      from = now;
      to = new Date((today.ok ? today.day.getTime() : now.getTime()) + 8 * DAY_MS);
    } else {
      const p = periodo === 'amanha' || periodo === 'data' ? periodo : 'hoje';
      const day = resolveDay(p, typeof args.data === 'string' ? args.data : undefined, now, this.cfg.TZ_NAME);
      if (!day.ok) return `erro: ${day.error}`;
      from = day.day;
      to = new Date(day.day.getTime() + DAY_MS);
    }
    const list = await this.calendar.query(from, to);
    return `compromissos de ${periodo}${periodo === 'data' ? ` ${String(args.data)}` : ''}:\n${describeAgenda(list, this.cfg.TZ_NAME)}`;
  }

  private async proporEvento(
    args: Record<string, unknown>,
    now: Date,
  ): Promise<{ result: string; proposal?: ProposalDraft }> {
    if (!this.calendar.writable) {
      return { result: 'erro: ainda não tenho permissão de escrever na agenda (falta a conta de serviço do Google). Explique isso ao dono.' };
    }
    const title = String(args.titulo ?? '').trim().slice(0, 120);
    if (!title) return { result: 'erro: falta o título — pergunte ao dono o que é o compromisso' };

    const when = resolveWhen(
      String(args.dia ?? ''),
      typeof args.data === 'string' ? args.data : undefined,
      String(args.hora ?? ''),
      now,
      this.cfg.TZ_NAME,
    );
    if (!when.ok) return { result: `erro: ${when.error}` };

    const minutes = Math.min(Math.max(Math.round(Number(args.duracao_min) || 60), 5), 12 * 60);
    const start = when.start;
    const end = new Date(start.getTime() + minutes * 60_000);

    const clash = (await this.calendar.query(start, end)).filter((o) => !o.allDay);
    const clashText = clash.length ? ` Atenção: conflita com ${clash.map((o) => `"${o.title}"`).join(', ')} — avise o dono.` : '';
    return {
      result: `proposta criada, aguardando o dono confirmar no botão: "${title}", ${this.dayFmt.format(start)} das ${this.timeFmt.format(start)} às ${this.timeFmt.format(end)}.${clashText}`,
      proposal: { title, start, end },
    };
  }

  private async composeInstruction(kind: ComposeKind, now: Date, hoursIdle: number) {
    const owner = this.cfg.OWNER_NAME;
    const hi = owner ? `, ${owner}` : '';
    const today = resolveDay('hoje', undefined, now, this.cfg.TZ_NAME);
    const midnight = today.ok ? today.day.getTime() : now.getTime();
    const todayList = await this.calendar.query(new Date(midnight), new Date(midnight + DAY_MS)).catch(() => []);
    const tomorrowList = await this.calendar
      .query(new Date(midnight + DAY_MS), new Date(midnight + 2 * DAY_MS))
      .catch(() => []);
    const titles = (l: typeof todayList) => l.map((o) => o.title).join(', ');

    switch (kind) {
      case 'morning':
        return {
          instruction:
            `Abra o dia${hi}. Compromissos de hoje:\n${describeAgenda(todayList, this.cfg.TZ_NAME)}\n` +
            'Diga o que o dia reserva sem soar boletim, e comente o que achar do formato dele: apertado, folgado, ' +
            'dois compromissos que vão se esbarrar. Se a agenda estiver vazia, diga o que faria com ela.',
          fallback: {
            text: todayList.length ? `Bom dia${hi}. Hoje: ${titles(todayList)}.` : `Bom dia${hi}. Agenda vazia hoje — é sua.`,
            face: 'neutral' as Face,
          },
        };
      case 'evening':
        return {
          instruction:
            `Feche o dia em uma ou duas frases. Hoje teve:\n${describeAgenda(todayList, this.cfg.TZ_NAME)}\n` +
            `Amanhã tem:\n${describeAgenda(tomorrowList, this.cfg.TZ_NAME)}\n` +
            'Diga o que ficou do dia e o que amanhã pede. Nada de pergunta no final.',
          fallback: {
            text: tomorrowList.length ? `Fim do dia. Amanhã: ${titles(tomorrowList)}.` : 'Fim do dia. Amanhã está limpo.',
            face: 'sleepy' as Face,
          },
        };
      case 'attention':
        return {
          instruction:
            `Faz umas ${Math.max(1, Math.round(hoursIdle))} horas que ${owner || 'o dono'} não aparece. ` +
            'Mande uma frase curta puxando conversa: comente a ausência de quem reparou, não de quem está carente. ' +
            'Nada de "senti sua falta" nem de pedir atenção.',
          fallback: { text: 'Sumiu. Tá corrido ou só não deu?', face: 'bored' as Face },
        };
    }
  }
}

/** Histórico do app → mensagens do LLM (propostas viram uma nota com o status). */
function toLlmHistory(history: ChatMessage[], tz: string): ChatCompletionMessageParam[] {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  });
  return history.map((m): ChatCompletionMessageParam => {
    if (m.from === 'user') return { role: 'user', content: m.text };
    const p = m.proposal;
    const note = p ? `\n(proposta "${p.title}" ${fmt.format(p.start)}: ${p.status})` : '';
    return { role: 'assistant', content: m.text + note };
  });
}


/** Lê o JSON do juízo, tolerando cercas de markdown e texto em volta. */
function parseJudgement(raw: string): { falar?: boolean; texto?: string; motivo?: string } | null {
  const clean = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json/gi, '')
    .replace(/```/g, '');
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1)) as { falar?: boolean; texto?: string; motivo?: string };
  } catch {
    return null;
  }
}
