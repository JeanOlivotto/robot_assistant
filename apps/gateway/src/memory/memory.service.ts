import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChatMessage } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import { LlmService } from '../llm/llm.service.js';

export interface Memoria {
  id: string;
  texto: string;
  createdAt: number;
  lastSeenAt: number; // última vez que apareceu na conversa ou que o robô citou
  mentions: number;
}

const MAX = 40; // guarda os assuntos mais vivos; passa disso, esquece os mais antigos
const NORMALIZE = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Memória de longo prazo: assuntos importantes do dono que o robô guarda por semanas
 * (projetos, saúde, pessoas, metas) para citar de vez em quando — "faz tempo que não falamos disso".
 */
@Injectable()
export class MemoryService {
  private readonly log = new Logger(MemoryService.name);
  private readonly file: string;
  private items: Memoria[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly llm: LlmService,
  ) {
    this.file = rootPath(`${cfg.DATA_DIR}/lembrancas.json`);
    try {
      this.items = JSON.parse(readFileSync(this.file, 'utf8')) as Memoria[];
    } catch {
      /* primeira vez */
    }
  }

  all(): Memoria[] {
    return this.items;
  }

  /** Frases curtas para o robô saber do que se lembra (entram no prompt). */
  summaries(limit = 12): string[] {
    return [...this.items].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, limit).map((m) => m.texto);
  }

  /** Um assunto que não aparece há um tempo, para o robô puxar de volta. */
  stale(minDays: number): Memoria | null {
    const cutoff = Date.now() - minDays * 24 * 3600_000;
    const old = this.items.filter((m) => m.lastSeenAt < cutoff).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    return old[0] ?? null;
  }

  /** Marca que um assunto voltou à tona agora (o robô citou, ou o dono falou dele). */
  touch(id: string): void {
    const m = this.items.find((x) => x.id === id);
    if (m) {
      m.lastSeenAt = Date.now();
      m.mentions += 1;
      this.save();
    }
  }

  /** Esquece tudo o que sabia do dono. */
  clear(): number {
    const had = this.items.length;
    this.items = [];
    this.save();
    this.log.log(`Memória apagada (${had} assunto(s))`);
    return had;
  }

  note(texto: string): void {
    const clean = texto.trim().slice(0, 120);
    if (!clean) return;
    const key = NORMALIZE(clean);
    const existing = this.items.find((m) => NORMALIZE(m.texto) === key);
    if (existing) {
      existing.lastSeenAt = Date.now();
      existing.mentions += 1;
      return;
    }
    this.items.push({ id: randomUUID(), texto: clean, createdAt: Date.now(), lastSeenAt: Date.now(), mentions: 1 });
  }

  /** Lê a conversa recente e guarda os assuntos duradouros que valem a pena lembrar. */
  async learn(history: ChatMessage[]): Promise<void> {
    if (!this.llm.enabled || history.length === 0) return;
    const texto = history
      .slice(-12)
      .map((m) => `${m.from === 'user' ? 'Dono' : 'Robô'}: ${m.text}${m.photo?.desc ? ` [mandou foto: ${m.photo.desc}]` : ''}`)
      .join('\n');
    try {
      const msg = await this.llm.complete(
        [
          {
            role: 'system',
            content:
              'Você cuida da memória de longo prazo de um robô sobre o dono dele. Da conversa, extraia ASSUNTOS ' +
              'DURADOUROS que valham lembrar por semanas: projetos, trabalho, saúde, pessoas importantes, metas, ' +
              'viagens, hobbies, decisões pessoais. NÃO inclua compromissos de agenda, tarefas pontuais, saudações ' +
              'ou trivialidades. Responda SOMENTE com JSON {"assuntos": string[]}, cada assunto curto (2 a 6 ' +
              'palavras), do ponto de vista do dono. Se não houver nada relevante, {"assuntos": []}.',
          },
          { role: 'user', content: texto },
        ],
        undefined,
        { maxTokens: 300, temperature: 0.2 },
      );
      for (const a of this.parse(msg.content ?? '')) this.note(a);
      this.trim();
      this.save();
    } catch (err) {
      this.log.warn(`learn() falhou: ${(err as Error).message}`);
    }
  }

  private parse(raw: string): string[] {
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '');
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    try {
      const obj = JSON.parse(clean.slice(start, end + 1)) as { assuntos?: unknown };
      if (!Array.isArray(obj.assuntos)) return [];
      return obj.assuntos.filter((a): a is string => typeof a === 'string' && a.trim().length > 2).slice(0, 8);
    } catch {
      return [];
    }
  }

  private trim(): void {
    if (this.items.length <= MAX) return;
    this.items.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    this.items = this.items.slice(0, MAX);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.items));
    } catch (err) {
      this.log.warn(`Falha ao salvar lembranças: ${(err as Error).message}`);
    }
  }
}
