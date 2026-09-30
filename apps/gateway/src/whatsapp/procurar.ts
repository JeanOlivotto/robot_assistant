import { semAcento } from './mensagem.js';

/**
 * Achar a conversa quando o dono não lembra o nome: cliente que não está na agenda do celular, e
 * que ele só sabe pelo final do número ou pelo assunto ("o que falou da nota fiscal ontem").
 */

/** Uma mensagem guardada só como texto (sem mídia), por uns dias: é por ela que se acha pelo assunto. */
export interface Lembranca {
  /** A conversa (pode ser LID) — e o número de telefone dela, quando o WhatsApp contou. */
  chat: string;
  pn?: string;
  nome: string;
  grupo: boolean;
  autor: string;
  texto: string;
  ts: number;
}

/** Palavras do pedido que não dizem nada do assunto ("o cliente que me mandou sobre a nota ontem"). */
const VAZIAS = new Set(
  (
    'que pra para com sem uma umas uns dos das nos nas pelo pela pelos pelas isso esse essa este esta aquele aquela ' +
    'cliente clientes pessoa cara mulher moca moco mandou mandaram falou falaram sobre ontem hoje semana mes passada ' +
    'passado mensagem mensagens conversa quem tinha tava estava perguntou pediu assunto dia ele ela eles elas meu minha'
  ).split(' '),
);

/**
 * Dígitos que o dono disse ("final 4321", "(11) 98888-7777"). Menos de 4 não identifica ninguém, e nome
 * com número no meio ("Turma 2024") é nome, não telefone.
 */
export function digitosDe(texto: string): string | null {
  const resto = semAcento(texto).replace(/\b(o|a|pro|pra|para|numero|n|final|que|termina|terminado|terminando|em|com|do|de|celular|telefone|zap|whats)\b/g, '');
  if (/[a-z]/.test(resto)) return null;
  const d = texto.replace(/\D/g, '');
  return d.length >= 4 ? d : null;
}

/** O jid é de telefone e termina nesses dígitos? (ele fala o final, ou o número sem o 55) */
export function numeroBate(jid: string, digitos: string): boolean {
  const [n, dominio] = jid.split('@');
  return dominio === 's.whatsapp.net' && !!n && n.split(':')[0]!.endsWith(digitos);
}

/** Número inteiro falado → jid. Sem o código do país (10 ou 11 dígitos), é do Brasil. */
export function jidDoNumero(digitos: string): string | null {
  if (digitos.length < 10 || digitos.length > 13) return null;
  return `${digitos.length <= 11 ? `55${digitos}` : digitos}@s.whatsapp.net`;
}

/**
 * As conversas que falaram do assunto, a melhor primeiro (mais palavras do pedido; empate, a mais
 * recente). Uma por conversa, com a mensagem que mais bateu. Palavra casa pelo começo: "nota" acha "notas".
 */
export function porAssunto(lembrancas: Lembranca[], sobre: string, max = 5): { l: Lembranca; pontos: number }[] {
  const termos = [...new Set(semAcento(sobre).split(' '))].filter((w) => w.length >= 3 && !VAZIAS.has(w));
  if (!termos.length) return [];
  const melhor = new Map<string, { l: Lembranca; pontos: number }>();
  for (const l of lembrancas) {
    const texto = ` ${semAcento(l.texto)}`;
    const pontos = termos.filter((w) => texto.includes(` ${w}`)).length;
    if (!pontos) continue;
    const antes = melhor.get(l.chat);
    if (!antes || pontos > antes.pontos || (pontos === antes.pontos && l.ts > antes.l.ts)) melhor.set(l.chat, { l, pontos });
  }
  return [...melhor.values()].sort((a, b) => b.pontos - a.pontos || b.l.ts - a.l.ts).slice(0, max);
}
