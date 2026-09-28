import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TZDate } from '@date-fns/tz';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

const NOME_DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

interface Combinado {
  /** Dias da semana (0 = domingo) em que ele não puxa conversa. */
  folgas: number[];
  /** Não puxa conversa até este instante (0 = sem pausa). */
  ate: number;
}

/**
 * O que o dono combinou sobre quando o robô NÃO manda mensagem por conta própria. Fica fora do
 * modelo de propósito: "não me manda nada até segunda" ficava só na conversa, saía do histórico
 * e ele mandou 30 mensagens no sábado e mais 30 no domingo. Aqui quem cala é o código.
 */
@Injectable()
export class SilencioService {
  private readonly log = new Logger(SilencioService.name);
  private readonly file: string;
  /* Sem nada combinado ainda, fim de semana é folga (foi o primeiro pedido do Jean). */
  private c: Combinado = { folgas: [0, 6], ate: 0 };

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/silencio.json`);
    try {
      this.c = { ...this.c, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Combinado>) };
    } catch {
      /* nada combinado ainda */
    }
  }

  /** Por que ele deve ficar quieto agora (null = pode falar). */
  motivo(now = new Date()): string | null {
    if (this.c.ate > now.getTime()) return `pausa até ${this.quando(this.c.ate)}`;
    const dia = new TZDate(now.getTime(), this.cfg.TZ_NAME).getDay();
    if (this.c.folgas.includes(dia)) return `folga de ${NOME_DIA[dia]}`;
    return null;
  }

  /** Cala até o início (meia-noite) do dia dado. */
  pausarAte(dia: Date): void {
    this.c.ate = dia.getTime();
    this.save();
    this.log.log(`Sem mensagens espontâneas até ${this.quando(this.c.ate)}`);
  }

  retomar(): void {
    this.c.ate = 0;
    this.save();
  }

  definirFolgas(dias: number[]): void {
    this.c.folgas = [...new Set(dias.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    this.save();
    this.log.log(`Folgas: ${this.c.folgas.map((d) => NOME_DIA[d]).join(', ') || 'nenhuma'}`);
  }

  get folgas(): number[] {
    return this.c.folgas;
  }

  /** Para o prompt: o que está combinado, em português. */
  descricao(now = new Date()): string {
    const partes: string[] = [];
    if (this.c.folgas.length) partes.push(`não manda mensagem por conta própria em: ${this.c.folgas.map((d) => NOME_DIA[d]).join(', ')}`);
    if (this.c.ate > now.getTime()) partes.push(`está em pausa até ${this.quando(this.c.ate)}`);
    return partes.join('; ');
  }

  private quando(ts: number): string {
    return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: this.cfg.TZ_NAME }).format(ts);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.c));
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`Falha ao salvar o combinado de silêncio: ${(err as Error).message}`);
    }
  }
}
