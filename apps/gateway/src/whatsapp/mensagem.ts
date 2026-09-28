import type { proto } from 'baileys';

/** Uma mensagem recebida, do jeito que o robô guarda (só na memória, nunca em disco). */
export interface Recebida {
  id: string;
  /** A conversa (pessoa ou grupo) — é para cá que vai a resposta. */
  chat: string;
  /** Nome da conversa: o contato, ou o nome do grupo. */
  nomeChat: string;
  /** Quem escreveu (num grupo, a pessoa; fora dele, o mesmo que nomeChat). */
  autor: string;
  grupo: boolean;
  ts: number;
  tipo: 'texto' | 'audio' | 'foto' | 'video' | 'documento' | 'figurinha' | 'contato' | 'local' | 'outro';
  /** Texto, legenda da foto ou nome do documento. */
  texto: string;
  /** Duração do áudio, em segundos. */
  segundos?: number;
}

type Tipo = Recebida['tipo'];

/** Tira os invólucros (efêmera, "ver uma vez", editada) e devolve a mensagem de verdade. */
export function desembrulhar(m: proto.IMessage | null | undefined): proto.IMessage | undefined {
  let atual = m ?? undefined;
  for (let i = 0; i < 5 && atual; i++) {
    const dentro =
      atual.ephemeralMessage?.message ??
      atual.viewOnceMessage?.message ??
      atual.viewOnceMessageV2?.message ??
      atual.viewOnceMessageV2Extension?.message ??
      atual.documentWithCaptionMessage?.message ??
      atual.editedMessage?.message;
    if (!dentro) break;
    atual = dentro;
  }
  return atual;
}

/** Tipo e texto legível de uma mensagem; null para o que não é conversa (reação, aviso de sistema…). */
export function conteudo(m: proto.IMessage | null | undefined): { tipo: Tipo; texto: string; segundos?: number } | null {
  const msg = desembrulhar(m);
  if (!msg) return null;
  if (msg.conversation) return { tipo: 'texto', texto: msg.conversation };
  if (msg.extendedTextMessage?.text) return { tipo: 'texto', texto: msg.extendedTextMessage.text };
  if (msg.audioMessage) return { tipo: 'audio', texto: '', segundos: Number(msg.audioMessage.seconds ?? 0) || undefined };
  if (msg.imageMessage) return { tipo: 'foto', texto: msg.imageMessage.caption ?? '' };
  if (msg.videoMessage) return { tipo: 'video', texto: msg.videoMessage.caption ?? '' };
  if (msg.documentMessage) return { tipo: 'documento', texto: msg.documentMessage.caption || msg.documentMessage.fileName || '' };
  if (msg.stickerMessage) return { tipo: 'figurinha', texto: '' };
  if (msg.contactMessage) return { tipo: 'contato', texto: msg.contactMessage.displayName ?? '' };
  if (msg.locationMessage || msg.liveLocationMessage) return { tipo: 'local', texto: msg.locationMessage?.name ?? '' };
  // Reação, apagada, enquete, protocolo: não é algo que alguém "mandou para ler".
  return null;
}

export const semAcento = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Acha a conversa pelo nome que o dono falou ("o Fábio", "grupo da obra"). Igual ganha de
 * "começa com", que ganha de "contém". Mais de uma no mesmo nível = ambíguo (o robô pergunta).
 */
export function acharPorNome<T extends { id: string; nome: string }>(lista: T[], falado: string): { achou?: T; parecidos: T[] } {
  const alvo = semAcento(falado)
    .replace(/^(o|a|os|as|do|da|pro|pra|para)\s+/, '')
    .replace(/^grupo\s+(do|da|de|dos|das)?\s*/, '')
    .trim();
  if (!alvo) return { parecidos: [] };
  // A mesma conversa pode vir de mais de um lugar (agenda do celular, grupo, mensagem recente).
  const todos = [...new Map(lista.filter((x) => semAcento(x.nome)).map((x) => [x.id, x])).values()];
  const palavrasAlvo = new Set(alvo.split(' '));
  const niveis = [
    (n: string) => n === alvo,
    (n: string) => n.split(' ')[0] === alvo || n.startsWith(`${alvo} `),
    (n: string) => new RegExp(`\\b${alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(n),
    // O dono disse mais do que o nome guardado: "Jaque - TaxResearch" (agenda) e só "Jaque" (apelido).
    (n: string) => n.split(' ').every((p) => palavrasAlvo.has(p)),
  ];
  for (const nivel of niveis) {
    const ok = todos.filter((x) => nivel(semAcento(x.nome)));
    if (ok.length === 1) return { achou: ok[0], parecidos: [] };
    if (ok.length > 1) return { parecidos: ok.slice(0, 5) };
  }
  return { parecidos: [] };
}

/**
 * Mensagem que o robô manda em nome PRÓPRIO: a primeira linha diz quem é, sempre — quem recebe
 * precisa saber que não foi o dono que escreveu. Quem põe é o código, não o modelo.
 */
export function assinar(texto: string, robo: string, dono: string): string {
  const quem = `🤖 *${robo}*${dono ? `, assistente de ${dono}` : ''}`;
  return texto.startsWith(quem) ? texto : `${quem}\n${texto}`;
}

/**
 * A mensagem chama o robô pelo nome? Só vale como vocativo — no começo ("Miro, tudo bem?", "oi
 * Miro") ou no fim ("tá aí, Miro?") —, não citado no meio ("o Miro do Jean é legal").
 */
export function chamou(texto: string, nome: string): boolean {
  const n = semAcento(nome);
  const t = semAcento(texto);
  if (!n || !t) return false;
  const saudacao = '(?:(?:oi|ola|opa|ei|hey|e ai|eai|fala|salve|bom dia|boa tarde|boa noite|alo)\\s+)?';
  return new RegExp(`^${saudacao}${n}\\b`).test(t) || new RegExp(`\\b${n}$`).test(t);
}

const ROTULO: Record<Tipo, string> = {
  texto: '',
  audio: 'áudio',
  foto: 'foto',
  video: 'vídeo',
  documento: 'documento',
  figurinha: 'figurinha',
  contato: 'contato',
  local: 'localização',
  outro: 'mensagem',
};

/** Uma linha para o cérebro ler: "14:32 · Fábio (grupo Obra): texto". */
export function descrever(m: Recebida, hora: string, transcricao?: string): string {
  const quem = m.grupo ? `${m.autor} (no grupo "${m.nomeChat}")` : m.nomeChat;
  let corpo: string;
  if (m.tipo === 'texto') corpo = m.texto;
  else if (m.tipo === 'audio') corpo = transcricao ? `[áudio] ${transcricao}` : `[áudio${m.segundos ? ` de ${m.segundos}s` : ''}, sem transcrição]`;
  else corpo = `[${ROTULO[m.tipo]}]${m.texto ? ` ${m.texto}` : ''}`;
  return `${hora} · ${quem}: ${corpo.slice(0, 1500)}`;
}
