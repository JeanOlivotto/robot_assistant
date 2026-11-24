import type { Recebida } from './mensagem.js';

/**
 * Quem está esperando resposta do dono no WhatsApp: a conversa em que a última palavra é da outra
 * pessoa. Só o quem e o quando (nome, desde quando, quantas mensagens) — o conteúdo não fica aqui,
 * e é isso que vai para o bom-dia ("a Bruna te mandou 3 áudios ontem à tarde e ficou sem resposta").
 */
export interface Espera {
  /** A conversa (pessoa ou grupo). */
  chat: string;
  /** No privado, o outro jid da mesma pessoa (número ↔ LID): a resposta pode vir por qualquer um. */
  alt?: string;
  nome: string;
  grupo: boolean;
  /** A primeira mensagem sem resposta. */
  desde: number;
  ultima: number;
  mensagens: number;
  audios: number;
}

const MAX = 60;
/** Mais velha que isso, ou ele já respondeu por fora (ligação, pessoalmente) ou não vai responder. */
const VALIDADE_MS = 4 * 24 * 3600_000;
/** "ok", "valeu", "kkk", 👍: fecha conversa, não pede resposta. */
const SO_FECHANDO = /^(ok(ay|ey)?|blz|beleza|show|top|perfeito|certo|combinado|fechado|valeu|vlw|obrigad[oa]|obg|brigad[oa]|tmj|de nada|bom dia|boa tarde|boa noite|(k|h|a|s|r){3,}|[\p{Extended_Pictographic}\p{Emoji_Modifier}\s\u200d\ufe0f]+)[\s!.,]*$/iu;

/** Esta mensagem que chegou pede resposta do dono? */
export function pedeResposta(m: Pick<Recebida, 'grupo' | 'paraDono' | 'doDono' | 'tipo' | 'texto'>): boolean {
  if (m.doDono) return false;
  if (m.grupo && !m.paraDono) return false; // num grupo, só o que é com ele (marcou ou respondeu)
  if (m.tipo === 'figurinha') return false;
  if (m.tipo === 'texto' && SO_FECHANDO.test(m.texto.trim())) return false;
  return true;
}

export class Esperas {
  private lista: Espera[];

  constructor(salvas: Espera[] = []) {
    this.lista = salvas.filter((e) => e && typeof e.chat === 'string' && Number.isFinite(e.desde));
  }

  /** Chegou mensagem que pede resposta: abre a espera da conversa, ou soma na que já está aberta. */
  chegou(m: Pick<Recebida, 'chat' | 'alt' | 'nomeChat' | 'grupo' | 'ts' | 'tipo'>): void {
    const e = this.lista.find((x) => x.chat === m.chat);
    if (e) {
      e.ultima = Math.max(e.ultima, m.ts);
      e.mensagens += 1;
      if (m.tipo === 'audio') e.audios += 1;
      e.nome = m.nomeChat || e.nome;
      return;
    }
    this.lista.push({
      chat: m.chat,
      alt: m.alt,
      nome: m.nomeChat,
      grupo: m.grupo,
      desde: m.ts,
      ultima: m.ts,
      mensagens: 1,
      audios: m.tipo === 'audio' ? 1 : 0,
    });
    if (this.lista.length > MAX) this.lista = this.lista.sort((a, b) => b.ultima - a.ultima).slice(0, MAX);
  }

  /** O dono (ou o robô, com o "sim" dele) escreveu na conversa: ela não está mais esperando. true se mudou. */
  respondeu(...jids: (string | undefined)[]): boolean {
    const ids = new Set(jids.filter((j): j is string => !!j));
    const antes = this.lista.length;
    this.lista = this.lista.filter((e) => !ids.has(e.chat) && !(e.alt && ids.has(e.alt)));
    return this.lista.length !== antes;
  }

  /** As que estão esperando há pelo menos `minMs`, das mais antigas para as mais novas. */
  abertas(agora = Date.now(), minMs = 30 * 60_000): Espera[] {
    return this.lista
      .filter((e) => e.desde <= agora - minMs && e.ultima > agora - VALIDADE_MS)
      .sort((a, b) => a.desde - b.desde);
  }

  todas(agora = Date.now()): Espera[] {
    this.lista = this.lista.filter((e) => e.ultima > agora - VALIDADE_MS);
    return this.lista;
  }

  limpar(): void {
    this.lista = [];
  }
}
