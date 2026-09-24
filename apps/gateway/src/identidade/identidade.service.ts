import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

const MAX_SOBRE = 15;

const semAcento = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');

/**
 * "Robô" é o que ele É, não um nome. Em produção ele tinha recusado ter nome antes de ganhar
 * identidade e, coerente com o próprio histórico, "escolheu" Robo. Genérico não vale como nome.
 */
const GENERICOS = ['robo', 'robot', 'robozinho', 'assistente', 'bot', 'ia', 'maquina'];

interface Identidade {
  /** O nome que ele mesmo escolheu (vazio: ainda usa o da configuração). */
  nome?: string;
  /** O que ele decidiu sobre si: gostos, jeito, opiniões, história. */
  sobre: string[];
}

/**
 * Quem o robô é, do jeito que ele mesmo decidiu. O nome da configuração (ROBOT_NAME) é só o
 * ponto de partida: perguntado, ele escolhe um nome de verdade, gostos e opiniões — e isto
 * guarda, para ele não ser uma pessoa diferente a cada conversa.
 */
@Injectable()
export class IdentidadeService {
  private readonly log = new Logger(IdentidadeService.name);
  private readonly file: string;
  private eu: Identidade = { sobre: [] };

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/identidade.json`);
    try {
      this.eu = { sobre: [], ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Identidade>) };
    } catch {
      /* ainda não se decidiu */
    }
  }

  get nome(): string {
    return this.escolheuNome ? this.eu.nome! : this.cfg.ROBOT_NAME;
  }

  /** Já escolheu um nome próprio (e não um genérico como "Robô")? */
  get escolheuNome(): boolean {
    return !!this.eu.nome && !this.generico(this.eu.nome);
  }

  /** "Robô", "assistente", o nome do dono…: não é nome próprio. */
  generico(nome: string): boolean {
    const n = semAcento(nome);
    const dono = semAcento(this.cfg.OWNER_NAME || '');
    return !n || GENERICOS.some((g) => n === g || n.startsWith(g) || n.endsWith(g)) || (!!dono && n.includes(dono));
  }

  get sobre(): string[] {
    return this.eu.sobre;
  }

  definirNome(nome: string): string {
    const limpo = nome.trim().replace(/\s+/g, ' ').slice(0, 30);
    if (!limpo) throw new Error('nome vazio');
    if (this.generico(limpo)) throw new Error(`"${limpo}" não é nome, é o que você é`);
    const antes = this.nome;
    this.eu.nome = limpo;
    this.save();
    this.log.log(`Ele escolheu um nome: ${antes} → ${limpo}`);
    return limpo;
  }

  /** Guarda algo que ele decidiu sobre si (o mesmo assunto dito de novo substitui o anterior). */
  lembrarDeMim(fato: string): void {
    const limpo = fato.trim().slice(0, 160);
    if (!limpo) return;
    // O assunto é o que vem antes dos dois-pontos ("Gosto de música: jazz"); sem eles, a frase inteira.
    const assunto = (f: string) => {
      const i = f.indexOf(':');
      return (i > 0 && i < 40 ? f.slice(0, i) : f).trim().toLowerCase();
    };
    const chave = assunto(limpo);
    this.eu.sobre = [...this.eu.sobre.filter((f) => assunto(f) !== chave), limpo].slice(-MAX_SOBRE);
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.eu));
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`Falha ao salvar a identidade: ${(err as Error).message}`);
    }
  }
}
