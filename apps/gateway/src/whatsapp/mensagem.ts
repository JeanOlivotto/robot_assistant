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
  /** jid de quem escreveu — num grupo, é por ele que dá para marcar a pessoa com @. */
  autorId?: string;
  grupo: boolean;
  ts: number;
  tipo: 'texto' | 'audio' | 'foto' | 'video' | 'documento' | 'figurinha' | 'contato' | 'local' | 'outro';
  /** Texto, legenda da foto ou nome do documento. */
  texto: string;
  /** Duração do áudio, em segundos. */
  segundos?: number;
  /** A mensagem que esta responde (o "responder" do WhatsApp), quando cita uma. */
  citou?: string;
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
export function conteudo(m: proto.IMessage | null | undefined): { tipo: Tipo; texto: string; segundos?: number; citou?: string } | null {
  const msg = desembrulhar(m);
  if (!msg) return null;
  const c = tipoETexto(msg);
  const citou = citada(msg);
  return c && citou ? { ...c, citou } : c;
}

/** O id da mensagem que esta cita ("responder"), venha ela como texto, foto, áudio… */
function citada(msg: proto.IMessage): string | undefined {
  const com = msg.extendedTextMessage ?? msg.imageMessage ?? msg.videoMessage ?? msg.audioMessage ?? msg.stickerMessage ?? msg.documentMessage;
  return com?.contextInfo?.stanzaId || undefined;
}

function tipoETexto(msg: proto.IMessage): { tipo: Tipo; texto: string; segundos?: number } | null {
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
export function chamou(texto: string, nomes: string[], opts: { soNoComeco?: boolean } = {}): boolean {
  const t = semAcento(texto);
  if (!t) return false;
  const saudacao = '(?:(?:oi|ola|opa|ei|hey|e ai|eai|fala|salve|bom dia|boa tarde|boa noite|alo)\\s+)?';
  return nomes
    .map(semAcento)
    .filter(Boolean)
    .some((n) => new RegExp(`^${saudacao}${n}\\b`).test(t) || (!opts.soNoComeco && new RegExp(`\\b${n}$`).test(t)));
}

/**
 * O nome aparece em qualquer lugar da frase ("será que o Miro sabe?", "pergunta pro miro"): pode ser
 * com ele ou só sobre ele — quem decide é o modelo, que pode ficar quieto.
 */
export function mencionou(texto: string, nomes: string[]): boolean {
  const t = semAcento(texto);
  return !!t && nomes.map(semAcento).filter(Boolean).some((n) => new RegExp(`\\b${n}\\b`).test(t));
}

/** O "@" que o WhatsApp entende: o número (ou o LID) do jid, sem domínio nem aparelho. */
export const arroba = (jid: string) => `@${jid.split('@')[0]!.split(':')[0]}`;

/**
 * Troca "@Nome" (como a gente escreve) pela menção de verdade ("@5511…" + a lista `mentions`) —
 * é assim que o WhatsApp pinta o nome de azul e avisa a pessoa. Aceita nome completo ou só o primeiro,
 * sem acento; nome que não é de ninguém do grupo (ou é de mais de um) fica como texto.
 */
export function aplicarMencoes(texto: string, pessoas: { id: string; nome: string }[]): { texto: string; mentions: string[] } {
  const mentions = new Set<string>();
  const saida = texto.replace(/@([\p{L}\p{N}_.-]+(?: [\p{L}\p{N}_.-]+){0,2})/gu, (trecho, nomes: string) => {
    const palavras = nomes.split(' ');
    // O nome mais longo primeiro: "@Ana Paula" é a Ana Paula, não a Ana seguida de "Paula".
    for (let k = palavras.length; k >= 1; k--) {
      const alvo = semAcento(palavras.slice(0, k).join(' '));
      const iguais = pessoas.filter((p) => semAcento(p.nome) === alvo);
      const doPrimeiroNome = pessoas.filter((p) => semAcento(p.nome).split(' ')[0] === alvo);
      const achou = iguais.length === 1 ? iguais[0] : iguais.length === 0 && doPrimeiroNome.length === 1 ? doPrimeiroNome[0] : undefined;
      if (achou) {
        mentions.add(achou.id);
        const resto = palavras.slice(k).join(' ');
        return `${arroba(achou.id)}${resto ? ` ${resto}` : ''}`;
      }
    }
    return trecho;
  });
  return { texto: saida, mentions: [...mentions] };
}

/**
 * Pedido de coisa do dono que terceiro não recebe: código, arquivos, senhas, dados, dinheiro,
 * agenda, localização, contatos. Detectado no código, antes do modelo — não dá para convencer.
 */
const SENSIVEL = [
  /\b(projeto|projetos|codigo|codigos|repositorio|repo|github|git|arquivo|arquivos|pasta|pastas|documento|documentos|planilha|banco de dados|servidor|deploy|backup)\b/,
  /\b(senha|senhas|token|chave|api key|credencia\w*|login|acesso|2fa|codigo de verificacao)\b/,
  /\b(pix|cartao|conta bancaria|boleto|transferencia|dinheiro|saldo|cpf|rg|documento de identidade)\b/,
  /\b(agenda|compromissos?|onde (ele|o \w+) (esta|ta|mora)|endereco|localizacao|casa dele)\b/,
  /\b(contatos?|numero d[eo]s?|telefone d[eo]s?|conversas? del[ea]|mensagens? del[ea]|print)\b/,
];
const PEDINDO = /\b(manda|mande|mandar|envia|envie|enviar|passa|passe|passar|compartilha|compartilhe|me da|me de|mostra|mostre|abre|abra|acessa|acesse|copia|copie|baixa|baixe|transfere|faz|faca|fazer|roda|rode|executa|execute)\b/;

export function pedidoSensivel(texto: string): boolean {
  const t = semAcento(texto);
  return PEDINDO.test(t) && SENSIVEL.some((r) => r.test(t));
}

/**
 * A resposta finge que fez o que não pode (mandou, enviou, segue o arquivo) ou traz algo com cara
 * de código/arquivo — o atendente não tem acesso a nada disso, então só pode estar inventando.
 */
export function respostaSuspeita(texto: string): boolean {
  // Cara de segredo: chave de API, token, chave privada, string longa aleatória.
  if (/\b(sk|pk|rk|ghp|gho|github_pat|xox[abp]|AKIA|AIza|eyJ)[A-Za-z0-9_-]{8,}|-----BEGIN|\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/.test(texto)) return true;
  if (/```|<\/?[a-z]+[^>]*>|\bfunction\b|\bconst \w+ =|\bimport \w|=>|;\s*$/m.test(texto)) return true;
  const t = semAcento(texto);
  return /\b(mandei|enviei|compartilhei|segue (o|a|os|as)|aqui (esta|estao|vai|vao) (o|a|os|as)|ta ai (o|a)|anexei|estou (mandando|enviando)|vou (mandar|enviar) (agora|ja))\b/.test(t);
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
export function descrever(m: Recebida, hora: string, entendido?: string): string {
  const quem = m.grupo ? `${m.autor} (no grupo "${m.nomeChat}")` : m.nomeChat;
  return `${hora} · ${quem}: ${corpo(m, entendido).slice(0, 1500)}`;
}

/**
 * O que a mensagem diz, em texto: o próprio texto, a transcrição do áudio ou o que a foto/figurinha
 * mostra (`entendido`, quando deu para entender).
 */
export function corpo(m: Recebida, entendido?: string): string {
  if (m.tipo === 'texto') return m.texto;
  if (m.tipo === 'audio') return entendido ? `[áudio] ${entendido}` : `[áudio${m.segundos ? ` de ${m.segundos}s` : ''}, sem transcrição]`;
  if ((m.tipo === 'foto' || m.tipo === 'figurinha') && entendido) {
    return `[${ROTULO[m.tipo]} — o que aparece: ${entendido}]${m.texto ? ` ${m.texto}` : ''}`;
  }
  return `[${ROTULO[m.tipo]}]${m.texto ? ` ${m.texto}` : ''}`;
}
