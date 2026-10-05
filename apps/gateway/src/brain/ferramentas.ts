import type { ChatMessage } from '@robo/protocol';
import { semAcento } from '../whatsapp/mensagem.js';

/**
 * As ferramentas vão em grupos: a descrição de todas (~5 mil tokens) ia em TODA chamada e, sozinha,
 * enchia o limite por minuto do Groq grátis (8 mil). Só vão as do assunto da conversa; o resto o
 * modelo pede com `mais_ferramentas` se precisar.
 */
export type Grupo = 'whatsapp' | 'computador' | 'vozes' | 'ajustes';
export const GRUPOS: Grupo[] = ['whatsapp', 'computador', 'vozes', 'ajustes'];

/** Ferramenta → grupo. Fora daqui (agenda, pendências, internet) vai sempre. */
export const GRUPO_DA_FERRAMENTA: Record<string, Grupo> = {
  ler_whatsapp: 'whatsapp',
  propor_whatsapp: 'whatsapp',
  apelidar_contato: 'whatsapp',
  privacidade_whatsapp: 'whatsapp',
  cobrir_whatsapp: 'whatsapp',
  usar_computador: 'computador',
  programar: 'computador',
  ligar_computador: 'computador',
  propor_comando: 'computador',
  resumir_arquivo: 'computador',
  salvar_voz: 'vozes',
  renomear_voz: 'vozes',
  esquecer_voz: 'vozes',
  definir_identidade: 'ajustes',
  silenciar_mensagens: 'ajustes',
  esquecer_assunto: 'ajustes',
};

/* Palavras (sem acento, minúsculas) que puxam cada grupo. Generosas de propósito: mandar um grupo à toa
   custa uns tokens; faltar a ferramenta faz ele dizer que não consegue. */
const PALAVRAS: Record<Grupo, RegExp> = {
  whatsapp:
    /\b(whats\w*|zap\w*|wpp|uats\w*|mensage\w*|msg|mandou|manda\w*|mande|envia\w*|respond\w*|contato\w*|grupo\w*|figurinha\w*|audio\w*|apelid\w*|privacidade|cobr\w*|recado\w*|avis[ae]\w*|chegou|escreveu|conversa\w*|lugar)\b|\bpor mim\b|\bfala (pro|pra|com)\b|\bdiz (pro|pra)\b/,
  computador:
    /\b(computador\w*|pc|notebook|note|maquina\w*|codigo\w*|projeto\w*|resum\w*|pdf|documento\w*|planilha\w*|program\w*|arquivo\w*|pasta\w*|terminal|comando\w*|rod[ae]\w*|instal\w*|lig[ae]\w*|abr[ea]\w*|git|deploy\w*|bug\w*|script\w*|site\w*|pagina\w*|html|build|servidor|vscode|code|desktop|linux|windows|desliga\w*|suspend\w*|reinici\w*)\b/,
  vozes: /\b(voz|vozes|sou o|sou a|meu nome|quem (fala|esta falando|e voce)|reconhec\w*|e eu|sou eu)\b/,
  ajustes:
    /\b(seu nome|se chamar|te chamar|personalidade|silencio\w*|silenci\w*|para de (mandar|falar)|nao me (manda|mande|chama)|fim de semana|esquec\w*|teste|nao importa|ignora)\b|\bvoce e\b|\bvoce (gosta|prefere)\b/,
};

/**
 * Os grupos que a conversa pede: as últimas falas dele e a última do robô (um "responde ele" depois
 * de ler o WhatsApp não fala em WhatsApp, mas a mensagem anterior falou).
 */
export function gruposDaConversa(history: ChatMessage[], extra: { voz?: boolean } = {}): Set<Grupo> {
  const dele = history.filter((m) => m.from === 'user').slice(-3);
  const doRobo = history.filter((m) => m.from === 'robot').slice(-2);
  const texto = semAcento([...dele, ...doRobo].map((m) => m.text).join(' \n '));
  const grupos = new Set(GRUPOS.filter((g) => PALAVRAS[g].test(texto)));
  // Recado do WhatsApp ou proposta de mensagem na conversa: o "sim", o "responde ele" é sobre isso.
  if (doRobo.some((m) => m.kind === 'whatsapp' || m.proposal?.kind === 'whatsapp')) grupos.add('whatsapp');
  // Comando proposto, ou comentário do código aberto no PC: o assunto é o computador.
  if (doRobo.some((m) => m.kind === 'codigo' || m.proposal?.kind === 'command')) grupos.add('computador');
  // Voz sem certeza, ou alguém que ainda não o conhece: pode precisar guardar a voz.
  const voz = history.at(-1)?.voz;
  if (extra.voz || (voz && voz.certeza !== 'alta')) grupos.add('vozes');
  return grupos;
}
