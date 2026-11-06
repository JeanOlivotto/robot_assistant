import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

export const TIPOS = ['suporte', 'saude', 'cadastro', 'outro'] as const;
export const PRIORIDADES = ['baixa', 'normal', 'urgente'] as const;
export type Tipo = (typeof TIPOS)[number];
export type Prioridade = (typeof PRIORIDADES)[number];

/** O corpo do POST /api/recados. */
export const NovoRecado = z
  .object({
    tipo: z.enum(TIPOS).default('outro'),
    prioridade: z.enum(PRIORIDADES).default('normal'),
    titulo: z.string().trim().min(1).max(120).optional(),
    texto: z.string().trim().max(2000).default(''),
    link: z
      .string()
      .trim()
      .max(500)
      .regex(/^https?:\/\/\S+$/, 'link precisa começar com http:// ou https://')
      .optional(),
    /** Mesma chave (por aplicação) atualiza o recado aberto em vez de criar outro. */
    chave: z.string().trim().min(1).max(120).optional(),
    /** true fecha o recado aberto com esta chave (ex.: a saúde voltou ao normal). */
    resolvido: z.boolean().default(false),
  })
  .refine((r) => r.resolvido || r.titulo, { message: 'titulo é obrigatório', path: ['titulo'] })
  .refine((r) => !r.resolvido || r.chave, { message: 'resolvido precisa da chave do recado', path: ['chave'] });
export type NovoRecado = z.infer<typeof NovoRecado>;

export interface Recado {
  id: string;
  app: string;
  chave?: string;
  tipo: Tipo;
  prioridade: Prioridade;
  titulo: string;
  texto: string;
  link?: string;
  criadoEm: number;
  atualizadoEm: number;
  /** Quantas vezes chegou (a mesma chave soma). */
  vezes: number;
  aberto: boolean;
  fechadoEm?: number;
  fechadoPor?: 'dono' | 'app';
  /** Última vez que o dono foi avisado (0 = nunca). */
  avisadoEm: number;
  /** O `vezes` no último aviso: se cresceu, tem novidade para contar. */
  avisadoVezes: number;
  /** Fechado pela aplicação depois de avisado: falta contar ao dono que normalizou. */
  avisarFechamento?: boolean;
}

/** Atualização do mesmo recado dentro desta janela não vira aviso novo — espera e junta. */
export const REAVISO_MS = 10 * 60_000;
const GUARDA_FECHADOS_MS = 30 * 24 * 3600_000;
const MAX_GUARDADOS = 500;
const PESO: Record<Prioridade, number> = { baixa: 0, normal: 1, urgente: 2 };

/** Os recados das aplicações: o que chegou, o que está aberto e o que já foi contado ao dono. */
@Injectable()
export class RecadosStore {
  private readonly log = new Logger(RecadosStore.name);
  private readonly file: string;
  private lista: Recado[] = [];

  /** `DATA_DIR` vazio = só em memória (testes). */
  constructor(@Inject(APP_CONFIG) cfg: Pick<AppConfig, 'DATA_DIR'>) {
    this.file = cfg.DATA_DIR ? rootPath(`${cfg.DATA_DIR}/recados.json`) : '';
    if (!this.file) return;
    try {
      this.lista = JSON.parse(readFileSync(this.file, 'utf8')) as Recado[];
    } catch {
      /* nenhum recado ainda */
    }
  }

  /** Registra o que a aplicação mandou. `recado` null = pediu para fechar algo que não estava aberto. */
  receber(app: string, r: NovoRecado, now = Date.now()): { recado: Recado | null; novo: boolean } {
    const aberto = r.chave ? this.lista.find((x) => x.aberto && x.app === app && x.chave === r.chave) : undefined;

    if (r.resolvido) {
      if (!aberto) return { recado: null, novo: false };
      aberto.aberto = false;
      aberto.fechadoEm = now;
      aberto.fechadoPor = 'app';
      aberto.atualizadoEm = now;
      if (r.texto) aberto.texto = r.texto;
      // Só conta que normalizou se o dono chegou a saber do problema.
      aberto.avisarFechamento = aberto.avisadoEm > 0 && aberto.prioridade !== 'baixa';
      this.save();
      return { recado: aberto, novo: false };
    }

    if (aberto) {
      aberto.titulo = r.titulo!;
      aberto.texto = r.texto;
      aberto.link = r.link ?? aberto.link;
      aberto.tipo = r.tipo;
      if (PESO[r.prioridade] > PESO[aberto.prioridade]) aberto.prioridade = r.prioridade;
      aberto.vezes += 1;
      aberto.atualizadoEm = now;
      this.save();
      return { recado: aberto, novo: false };
    }

    const novo: Recado = {
      id: randomUUID().slice(0, 8),
      app,
      ...(r.chave ? { chave: r.chave } : {}),
      tipo: r.tipo,
      prioridade: r.prioridade,
      titulo: r.titulo!,
      texto: r.texto,
      ...(r.link ? { link: r.link } : {}),
      criadoEm: now,
      atualizadoEm: now,
      vezes: 1,
      aberto: true,
      avisadoEm: 0,
      avisadoVezes: 0,
    };
    this.lista.push(novo);
    this.podar(now);
    this.save();
    return { recado: novo, novo: true };
  }

  /**
   * O que tem novidade para contar agora. Baixa prioridade nunca vai sozinha (entra no bom-dia e
   * quando ele pergunta); normal só quando `podeNormal` (horário e silêncio); urgente sempre.
   */
  paraAvisar(now: number, podeNormal: boolean): Recado[] {
    return this.lista.filter(
      (r) =>
        r.aberto &&
        r.prioridade !== 'baixa' &&
        (r.prioridade === 'urgente' || podeNormal) &&
        r.vezes > r.avisadoVezes &&
        (r.avisadoEm === 0 || now - r.avisadoEm >= REAVISO_MS),
    );
  }

  /** Fechados pela aplicação que o dono ainda não sabe que normalizaram. */
  fechamentosParaAvisar(podeNormal: boolean): Recado[] {
    return this.lista.filter((r) => r.avisarFechamento && (r.prioridade === 'urgente' || podeNormal));
  }

  marcarAvisados(recados: Recado[], now = Date.now()): void {
    for (const r of recados) {
      if (r.aberto) {
        r.avisadoEm = now;
        r.avisadoVezes = r.vezes;
      } else r.avisarFechamento = false;
    }
    if (recados.length) this.save();
  }

  /** Abertos, do mais importante para o menos, e dentro disso do mais recente. */
  abertos(app?: string): Recado[] {
    return this.lista
      .filter((r) => r.aberto && (!app || r.app === app))
      .sort((a, b) => PESO[b.prioridade] - PESO[a.prioridade] || b.atualizadoEm - a.atualizadoEm);
  }

  recentes(n = 20, app?: string): Recado[] {
    return this.lista
      .filter((r) => !app || r.app === app)
      .sort((a, b) => b.atualizadoEm - a.atualizadoEm)
      .slice(0, n);
  }

  temAberto(app: string, chave: string): boolean {
    return this.lista.some((r) => r.aberto && r.app === app && r.chave === chave);
  }

  /** O dono deu baixa. `ids` vazio + `todos` = todos os abertos (da aplicação, se vier). */
  darBaixa(ids: string[], opts: { todos?: boolean; app?: string } = {}, now = Date.now()): Recado[] {
    const alvo = this.abertos(opts.app).filter((r) => opts.todos || ids.includes(r.id));
    for (const r of alvo) {
      r.aberto = false;
      r.fechadoEm = now;
      r.fechadoPor = 'dono';
      r.avisarFechamento = false;
    }
    if (alvo.length) this.save();
    return alvo;
  }

  /** "3 abertos — baixaxml: 2 suporte, 1 cadastro (1 urgente)". Vazio = nada aberto. */
  resumo(): string {
    const abertos = this.abertos();
    if (!abertos.length) return '';
    const porApp = new Map<string, Recado[]>();
    for (const r of abertos) porApp.set(r.app, [...(porApp.get(r.app) ?? []), r]);
    const partes = [...porApp].map(([app, rs]) => {
      const porTipo = new Map<string, number>();
      for (const r of rs) porTipo.set(r.tipo, (porTipo.get(r.tipo) ?? 0) + 1);
      const urgentes = rs.filter((r) => r.prioridade === 'urgente').length;
      return `${app}: ${[...porTipo].map(([t, n]) => `${n} ${t}`).join(', ')}${urgentes ? ` (${urgentes} urgente${urgentes > 1 ? 's' : ''})` : ''}`;
    });
    return `${abertos.length} aberto${abertos.length > 1 ? 's' : ''} — ${partes.join('; ')}`;
  }

  /** Fechados há mais de 30 dias saem; e nunca mais que MAX_GUARDADOS (os fechados mais velhos primeiro). */
  private podar(now: number): void {
    this.lista = this.lista.filter((r) => r.aberto || now - (r.fechadoEm ?? r.atualizadoEm) < GUARDA_FECHADOS_MS);
    if (this.lista.length <= MAX_GUARDADOS) return;
    const fechados = this.lista.filter((r) => !r.aberto).sort((a, b) => (a.fechadoEm ?? 0) - (b.fechadoEm ?? 0));
    const sai = new Set(fechados.slice(0, this.lista.length - MAX_GUARDADOS).map((r) => r.id));
    this.lista = this.lista.filter((r) => !sai.has(r.id));
    // Ainda demais (uma aplicação despejando recados abertos): os mais velhos saem, abertos ou não.
    if (this.lista.length > MAX_GUARDADOS) this.lista = this.lista.slice(-MAX_GUARDADOS);
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.lista));
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`Falha ao salvar recados: ${(err as Error).message}`);
    }
  }
}
