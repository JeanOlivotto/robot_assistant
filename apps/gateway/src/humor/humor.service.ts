import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { Face } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import type { Animo } from './animo.js';

/** As carinhas que viram humor. Pensativo, neutro, surpreso e confuso são do momento — não duram. */
const HUMORES: Partial<Record<Face, string>> = {
  happy: 'de bom humor',
  love: 'todo carinhoso',
  sad: 'meio pra baixo',
  worried: 'preocupado',
  bored: 'entediado',
  annoyed: 'irritado',
  angry: 'bravo',
};

/** "de bom humor", "entediado"... (vazio para carinha que não é humor). */
export function rotuloDoHumor(face: Face): string {
  return HUMORES[face] ?? '';
}

const DURA_MS = 3 * 3600_000; // sem nada que o renove, passado isso, passou
/** Uma emoção da conversa vale mais que o humor do dia por este tempo (ele está no meio do papo). */
const CONVERSA_MANDA_MS = 45 * 60_000;
/** Resposta alegre de rotina não apaga um humor próprio recente — senão ele vive "de bom humor". */
const PROPRIO_RESISTE_MS = 60 * 60_000;
const LINHA_MAX = 16;

interface Humor {
  face: Face;
  /** Por que ficou assim: a fala do dono (conversa) ou o que aconteceu no dia dele (dia). */
  porque?: string;
  desde: number;
  /** Última vez que o motivo ainda valia (o humor do dia é renovado enquanto a coisa continua). */
  visto?: number;
  origem?: 'conversa' | 'dia';
}

/** Uma troca de humor, para o diário contar como ele se sentiu. */
export interface Momento {
  ts: number;
  face: Face;
  porque?: string;
}

interface Salvo {
  atual: Humor | null;
  linha: Momento[];
}

/**
 * O humor do robô. Duas fontes: a emoção forte que ele mostrou numa resposta (dura umas horas e vai
 * passando — irritado agora não vira simpático do nada na próxima mensagem) e o dia DELE (animo.ts):
 * ficar no vácuo, ser elogiado, ver o dono trabalhando tarde. É o segundo que dá a sensação de que
 * ele tem vida própria: o humor muda sem ninguém ter falado nada com ele.
 */
@Injectable()
export class HumorService {
  private readonly log = new Logger(HumorService.name);
  private readonly file: string;
  private atual: Humor | null = null;
  private linha: Momento[] = [];
  private emitida: Face | null = null;
  /** A carinha do humor mudou (ou o humor passou: null). */
  readonly mudou$ = new Subject<Face | null>();

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/humor.json`);
    try {
      const salvo = JSON.parse(readFileSync(this.file, 'utf8')) as Salvo | Humor | null;
      if (salvo && 'face' in salvo) this.atual = salvo; // formato antigo: só o humor atual
      else if (salvo) {
        this.atual = salvo.atual;
        this.linha = salvo.linha ?? [];
      }
    } catch {
      /* primeira vez */
    }
    this.emitida = this.face();
  }

  /** Ele acabou de mostrar esta carinha numa resposta. Só as que viram humor trocam o atual. */
  sentiu(face: Face, porque?: string, agora = Date.now()): void {
    if (!HUMORES[face]) return;
    const vale = this.valido(agora);
    if (face === 'happy' && vale?.origem === 'dia' && vale.face !== 'happy' && agora - (vale.visto ?? vale.desde) < PROPRIO_RESISTE_MS) return;
    const curto = porque?.replace(/\s+/g, ' ').trim().slice(0, 100) || undefined;
    this.trocar({ face, porque: curto, desde: agora, visto: agora, origem: 'conversa' }, agora);
  }

  /**
   * O que o dia dele pede agora (animo.ts). Mesmo humor: só renova. Outro: troca — a não ser que ele
   * esteja no meio de uma conversa que o deixou de outro jeito. true = a carinha mudou.
   */
  viver(a: Animo | null, agora = Date.now()): boolean {
    if (!a) return this.conferir(agora);
    const vale = this.valido(agora);
    if (vale && vale.face === a.face) {
      vale.visto = agora;
      if (vale.origem === 'dia') vale.porque = a.porque;
      this.save();
      return false;
    }
    if (vale?.origem === 'conversa' && agora - (vale.visto ?? vale.desde) < CONVERSA_MANDA_MS) return false;
    this.trocar({ face: a.face, porque: a.porque, desde: agora, visto: agora, origem: 'dia' }, agora);
    this.log.log(`Humor próprio: ${HUMORES[a.face]} — ${a.porque}`);
    return this.emitida === a.face;
  }

  /** Como ele está agora, em uma frase para o prompt ("irritado, faz uns 40 min — ..."). Vazio se já passou. */
  descricao(agora = Date.now()): string {
    const h = this.valido(agora);
    if (!h) return '';
    const min = Math.round((agora - h.desde) / 60_000);
    const quando = min < 5 ? 'agora há pouco' : min < 60 ? `faz uns ${min} min` : `faz umas ${Math.round(min / 60)} hora(s)`;
    const passando = agora - (h.visto ?? h.desde) > DURA_MS / 2 ? ', já passando' : '';
    const porque = !h.porque ? '' : h.origem === 'dia' ? `, porque ${h.porque}` : `, desde que ouviu: "${h.porque}"`;
    return `${HUMORES[h.face]}${passando} (${quando}${porque})`;
  }

  /** A carinha do humor de agora (null se já passou) — o app mostra junto da descrição, e a bolha fica com ela. */
  face(agora = Date.now()): Face | null {
    return this.valido(agora)?.face ?? null;
  }

  /** O porquê do humor de agora, quando ele veio do dia dele (para o pensamento em voz alta). */
  motivoProprio(agora = Date.now()): string | null {
    const h = this.valido(agora);
    return h?.origem === 'dia' ? (h.porque ?? null) : null;
  }

  /** As trocas de humor de um dia (YYYY-MM-DD pelo `diaDe`), para o diário. */
  momentos(dia: string, diaDe: (ts: number) => string): Momento[] {
    return this.linha.filter((m) => diaDe(m.ts) === dia);
  }

  /** O humor passou sozinho (ninguém renovou): avisa quem mostra a carinha. */
  conferir(agora = Date.now()): boolean {
    const f = this.face(agora);
    if (f === this.emitida) return false;
    this.emitida = f;
    this.mudou$.next(f);
    return true;
  }

  private valido(agora: number): Humor | null {
    const h = this.atual;
    if (!h) return null;
    const passou = agora - (h.visto ?? h.desde);
    return passou < 0 || passou >= DURA_MS ? null : h;
  }

  private trocar(h: Humor, agora: number): void {
    const antes = this.valido(agora)?.face;
    this.atual = h;
    if (antes !== h.face) {
      this.linha = [...this.linha.filter((m) => agora - m.ts < 2 * 24 * 3600_000), { ts: agora, face: h.face, porque: h.porque && h.origem === 'conversa' ? `quando ele disse "${h.porque}"` : h.porque }].slice(-LINHA_MAX);
    }
    this.save();
    this.conferir(agora);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ atual: this.atual, linha: this.linha } satisfies Salvo));
    } catch (err) {
      this.log.warn(`Falha ao salvar humor: ${(err as Error).message}`);
    }
  }
}
