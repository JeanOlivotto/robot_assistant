import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

const MAX = 120;
/** Aberta há mais tempo que isso sem ninguém tocar nela: vira assunto morto e some. */
const VELHA_MS = 45 * 24 * 3600_000;
/**
 * Depois de tantas cobranças sem ela sair da lista, ele para de cobrar: virou ruído (o bug das
 * negativações foi cobrado em todo bom-dia por duas semanas). Continua na lista, só não puxa assunto.
 */
export const MAX_COBRANCAS = 4;

export type TaskOrigin = 'ata' | 'conversa' | 'manual' | 'whatsapp';

export interface Task {
  id: string;
  texto: string;
  /** Com quem é o compromisso ("mandar mensagem para o Fábio" → Fábio). */
  pessoa?: string;
  origem: TaskOrigin;
  /** Reunião de onde saiu, quando veio de uma ata. */
  meetingId?: string;
  createdAt: number;
  doneAt?: number;
  /** Quantas vezes o robô já cobrou, e quando foi a última. */
  nudges: number;
  lastNudgeAt: number;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * O que ficou de ser feito e não tem hora marcada: "mandar mensagem para o Fábio", "responder
 * a proposta". Sai das atas e da conversa, e o robô cobra por conta própria até você resolver.
 * Compromisso com dia e hora é agenda, não entra aqui.
 */
@Injectable()
export class TaskService {
  private readonly log = new Logger(TaskService.name);
  private readonly file: string;
  private tasks: Task[] = [];
  private readonly dono: string;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.dono = norm(cfg.OWNER_NAME ?? '').split(' ')[0] ?? '';
    this.file = rootPath(`${cfg.DATA_DIR}/tarefas.json`);
    try {
      this.tasks = JSON.parse(readFileSync(this.file, 'utf8')) as Task[];
    } catch {
      /* primeira vez */
    }
  }

  all(): Task[] {
    return [...this.tasks].sort((a, b) => Number(!!a.doneAt) - Number(!!b.doneAt) || b.createdAt - a.createdAt);
  }

  open(): Task[] {
    return this.tasks.filter((t) => !t.doneAt).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Cria, ou devolve a que já existe se for a mesma coisa dita de outro jeito. */
  add(texto: string, opts: { pessoa?: string; origem?: TaskOrigin; meetingId?: string } = {}): Task | null {
    const clean = texto.trim().slice(0, 160);
    if (clean.length < 3) return null;

    const key = norm(clean);
    const igual = this.tasks.find((t) => !t.doneAt && norm(t.texto) === key);
    if (igual) return igual;

    const task: Task = {
      id: randomUUID(),
      texto: clean,
      pessoa: opts.pessoa?.trim().slice(0, 40) || undefined,
      origem: opts.origem ?? 'manual',
      meetingId: opts.meetingId,
      createdAt: Date.now(),
      nudges: 0,
      lastNudgeAt: 0,
    };
    this.tasks.push(task);
    this.prune();
    this.save();
    this.log.log(`Pendência anotada (${task.origem}): ${task.texto}`);
    return task;
  }

  done(id: string): Task | null {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return null;
    t.doneAt = Date.now();
    this.save();
    this.log.log(`Pendência resolvida: ${t.texto}`);
    return t;
  }

  /** Troca o texto de uma pendência aberta ("renomeia"). */
  renomear(id: string, texto: string): Task | null {
    const t = this.tasks.find((x) => x.id === id && !x.doneAt);
    const limpo = texto.trim().slice(0, 160);
    if (!t || limpo.length < 3) return null;
    t.texto = limpo;
    this.save();
    return t;
  }

  /** Várias pendências viram uma só (com o texto dado); as outras saem da lista. */
  juntar(ids: string[], texto: string): Task | null {
    const alvo = this.tasks.filter((t) => ids.includes(t.id) && !t.doneAt);
    const limpo = texto.trim().slice(0, 160);
    if (alvo.length < 2 || limpo.length < 3) return null;
    const [primeira, ...resto] = alvo.sort((a, b) => a.createdAt - b.createdAt);
    primeira!.texto = limpo;
    const pessoas = [...new Set(alvo.map((t) => t.pessoa).filter(Boolean))];
    primeira!.pessoa = pessoas.length === 1 ? pessoas[0] : undefined;
    this.tasks = this.tasks.filter((t) => !resto.includes(t));
    this.save();
    this.log.log(`${alvo.length} pendências viraram uma: ${limpo}`);
    return primeira!;
  }

  /** Tira da lista de vez (não era tarefa, ou não vale mais). */
  drop(id: string): boolean {
    const antes = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length === antes) return false;
    this.save();
    return true;
  }

  /** O robô acabou de cobrar estas — registra para não repetir a mesma toda hora. */
  nudged(ids: string[]): void {
    const now = Date.now();
    let mexeu = false;
    for (const t of this.tasks) {
      if (!ids.includes(t.id) || t.doneAt) continue;
      t.nudges += 1;
      t.lastNudgeAt = now;
      mexeu = true;
    }
    if (mexeu) this.save();
  }

  /**
   * As que valem cobrar agora: abertas, dele, e não cobradas há pouco. O intervalo dobra a cada
   * cobrança (`horas`, depois 2×, 4×...) e, passando de MAX_COBRANCAS, ele para de cobrar.
   */
  worthNudging(horas = 20, agora = Date.now()): Task[] {
    return this.open().filter((t) => {
      if (!this.ehDoDono(t) || t.nudges >= MAX_COBRANCAS) return false;
      const espera = horas * 3600_000 * 2 ** Math.max(0, t.nudges - 1);
      return t.lastNudgeAt <= agora - espera;
    });
  }

  /**
   * Numa ata, `pessoa` é o responsável: tarefa do André é do André, não se cobra do dono. Nas outras
   * origens, `pessoa` é com quem ele combinou ("mandar mensagem para o Fábio") — a tarefa é dele.
   */
  private ehDoDono(t: Task): boolean {
    if (t.origem !== 'ata' || !t.pessoa) return true;
    return !!this.dono && norm(t.pessoa).split(' ')[0] === this.dono;
  }

  private prune(): void {
    const corte = Date.now() - VELHA_MS;
    this.tasks = this.tasks.filter((t) => !t.doneAt || t.doneAt > corte);
    if (this.tasks.length > MAX) this.tasks = this.tasks.slice(-MAX);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.tasks));
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`Falha ao salvar as pendências: ${(err as Error).message}`);
    }
  }
}
