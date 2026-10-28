import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Face } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

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

const DURA_MS = 3 * 3600_000; // passado isso, passou

interface Humor {
  face: Face;
  /** O que ele ouviu quando ficou assim (a fala do dono, curta). */
  porque?: string;
  desde: number;
}

/**
 * O humor do robô entre uma conversa e outra: a última emoção forte que ele mostrou dura umas
 * horas e vai passando — irritado agora não vira simpático do nada na próxima mensagem.
 */
@Injectable()
export class HumorService {
  private readonly log = new Logger(HumorService.name);
  private readonly file: string;
  private atual: Humor | null = null;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/humor.json`);
    try {
      this.atual = JSON.parse(readFileSync(this.file, 'utf8')) as Humor | null;
    } catch {
      /* primeira vez */
    }
  }

  /** Ele acabou de mostrar esta carinha. Só as que viram humor trocam o atual. */
  sentiu(face: Face, porque?: string, agora = Date.now()): void {
    if (!HUMORES[face]) return;
    const curto = porque?.replace(/\s+/g, ' ').trim().slice(0, 100) || undefined;
    this.atual = { face, porque: curto, desde: agora };
    this.save();
  }

  /** Como ele está agora, em uma frase para o prompt ("irritado, faz uns 40 min — ..."). Vazio se já passou. */
  descricao(agora = Date.now()): string {
    const h = this.atual;
    if (!h) return '';
    const passou = agora - h.desde;
    if (passou < 0 || passou >= DURA_MS) return '';
    const min = Math.round(passou / 60_000);
    const quando = min < 5 ? 'agora há pouco' : min < 60 ? `faz uns ${min} min` : `faz umas ${Math.round(min / 60)} hora(s)`;
    const passando = passou > DURA_MS / 2 ? ', já passando' : '';
    return `${HUMORES[h.face]}${passando} (${quando}${h.porque ? `, desde que ouviu: "${h.porque}"` : ''})`;
  }

  /** A carinha do humor de agora (null se já passou) — o app mostra junto da descrição. */
  face(agora = Date.now()): Face | null {
    return this.descricao(agora) ? this.atual!.face : null;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.atual));
    } catch (err) {
      this.log.warn(`Falha ao salvar humor: ${(err as Error).message}`);
    }
  }
}
