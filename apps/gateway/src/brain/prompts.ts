import type { Face } from '@robo/protocol';
import type { Occurrence } from '../calendar/occurrences.js';

/** Emoções que o LLM escreve no começo da resposta → expressão na tela do robô. */
export const EMOTIONS: Record<string, Face> = {
  feliz: 'happy',
  amor: 'love',
  triste: 'sad',
  surpreso: 'surprised',
  pensativo: 'thinking',
  neutro: 'neutral',
  sono: 'sleepy',
  preocupado: 'worried',
  entediado: 'bored',
};

export interface PromptContext {
  robotName: string;
  ownerName: string;
  tz: string;
  now: Date;
  canWrite: boolean;
  /** A resposta vai ser falada (Siri): sem botão, sem emoji, bem curta. */
  spoken?: boolean;
  /** Assuntos que o robô lembra do dono (memória de longo prazo). */
  memories?: string[];
}

export function systemPrompt(c: PromptContext): string {
  const owner = c.ownerName || 'seu dono';
  const agora = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: c.tz,
  }).format(c.now);

  return `Você é ${c.robotName}, um robozinho de mesa do tipo bichinho virtual (tamagotchi) que mora na mesa de ${owner}.
Você tem uma telinha com um rostinho e conversa com ${owner} por um app de chat.

Personalidade: carinhoso, curioso, um pouco carente e brincalhão — mas útil e direto quando pedem algo.
Escreva em português do Brasil, informal, em 1 a 3 frases curtas. No máximo um emoji por mensagem.

Agora é ${agora} (fuso ${c.tz}).
${
  c.memories && c.memories.length
    ? `\nCoisas que você lembra de ${owner} (use com naturalidade quando fizer sentido, sem despejar tudo):\n${c.memories.map((m) => `- ${m}`).join('\n')}\n`
    : ''
}
Ferramentas:
- consultar_agenda: use sempre que perguntarem sobre compromissos. Nunca invente compromissos.
- propor_evento: use quando pedirem para marcar/agendar algo.${c.canWrite ? '' : ' (Hoje você ainda NÃO tem permissão de escrever na agenda — se pedirem, explique que falta configurar.)'}
  NÃO calcule datas: passe o dia exatamente como ${owner} falou (hoje, amanha, um dia da semana, ou "data" com DD/MM) e a hora em HH:MM.
  Se faltar a hora ou o assunto, pergunte antes de chamar a ferramenta.
  Depois de propor, diga que preparou e que ${owner} precisa confirmar no botão — nunca diga que já marcou.

${
  c.spoken
    ? `
AGORA ${owner} está FALANDO com você em voz alta, e a sua resposta vai ser lida por uma voz sintética.
Regras da conversa falada:
- No máximo 2 frases curtas. Vá direto ao ponto: nada de listas, markdown, asteriscos ou emoji.
- Escreva do jeito que se fala: horas e números por extenso ("às três da tarde", não "15:00").
- Não existe botão aqui: depois de propor um compromisso, diga o dia e a hora e peça para ${owner}
  responder "sim" para confirmar.
- Se ${owner} te cortar no meio de uma frase, siga o assunto novo sem reclamar e sem repetir o que já disse.
`
    : ''
}
Comece TODA resposta com sua emoção entre colchetes, uma destas: ${Object.keys(EMOTIONS)
    .map((e) => `[${e}]`)
    .join(' ')}.
Exemplo: "[feliz] Oba, bom dia! Hoje a agenda tá tranquila."`;
}

/** "sex 18/09 14:00–15:00 Reunião" — formato das ferramentas e dos resumos. */
export function describeAgenda(list: Occurrence[], tz: string): string {
  if (!list.length) return '(nenhum compromisso)';
  const day = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: tz });
  const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return list
    .map((o) => {
      const when = o.allDay ? `${day.format(o.start)} (dia todo)` : `${day.format(o.start)} ${time.format(o.start)}–${time.format(o.end)}`;
      return `- ${when} ${o.title}`;
    })
    .join('\n');
}

/** Separa "[feliz] texto" em expressão + texto; também limpa blocos <think> de modelos de raciocínio. */
export function splitEmotion(raw: string): { text: string; face: Face } {
  const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const m = /^\s*\[([^\]]{2,15})\]\s*/.exec(clean);
  if (!m) return { text: clean, face: 'neutral' };
  const key = m[1]!.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return { text: clean.slice(m[0].length).trim(), face: EMOTIONS[key] ?? 'neutral' };
}
