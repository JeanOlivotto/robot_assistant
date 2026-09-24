import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

/*
 * Quão parecida (cosseno entre assinaturas) uma voz precisa ser. Medido em 24/09 com vozes em
 * português: a mesma voz deu 0,77–0,90 entre falas diferentes, vozes diferentes 0,09–0,40.
 * Voz de verdade em microfone de celular varia mais que voz sintética, então fica a folga:
 */
export const RECONHECE = 0.55; // daqui para cima, é a pessoa
export const DUVIDA = 0.42; // entre os dois: "acho que é", e ele confirma
const REFORCA = 0.65; // reconheceu com folga: a amostra nova entra no cadastro (fica mais robusto)
const MAX_AMOSTRAS = 20;
/* A voz não reconhecida do chat espera por um nome por este tempo; depois, ninguém mais a salva. */
const PENDENTE_MS = 15 * 60_000;

export interface VozConhecida {
  id: string;
  nome: string;
  /** Assinaturas de falas diferentes: a média delas é a voz da pessoa. */
  amostras: number[][];
  criadaEm: number;
  atualizadaEm: number;
}

export interface Reconhecimento {
  id: string;
  nome: string;
  /** Semelhança com a voz cadastrada (0–1). */
  score: number;
  certeza: 'alta' | 'duvida';
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

/**
 * O banco de vozes: quem já foi apresentado ao robô e como é a voz. Guarda só as assinaturas
 * (números que resumem o timbre), nunca o áudio. Assinatura de voz é dado biométrico: dá para
 * apagar a de qualquer pessoa a qualquer hora.
 */
@Injectable()
export class BancoVozesService {
  private readonly log = new Logger(BancoVozesService.name);
  private readonly file: string;
  private vozes: VozConhecida[] = [];
  /** A última voz do chat que ele não reconheceu (ou ficou em dúvida), esperando alguém dizer quem é. */
  private pendente: { embedding: number[]; at: number } | null = null;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/vozes-banco.json`);
    try {
      this.vozes = JSON.parse(readFileSync(this.file, 'utf8')) as VozConhecida[];
    } catch {
      /* primeira vez */
    }
  }

  /** Quem está no banco (sem as assinaturas). */
  listar(): { id: string; nome: string; amostras: number; atualizadaEm: number }[] {
    return this.vozes.map((v) => ({ id: v.id, nome: v.nome, amostras: v.amostras.length, atualizadaEm: v.atualizadaEm }));
  }

  /** A voz mais parecida com esta assinatura, se passar da dúvida. */
  identificar(embedding: number[]): Reconhecimento | null {
    let melhor: Reconhecimento | null = null;
    for (const v of this.vozes) {
      const score = cosseno(embedding, media(v.amostras));
      if (score >= DUVIDA && (!melhor || score > melhor.score)) {
        melhor = { id: v.id, nome: v.nome, score: +score.toFixed(3), certeza: score >= RECONHECE ? 'alta' : 'duvida' };
      }
    }
    return melhor;
  }

  /** Cadastra (ou acrescenta uma amostra a quem já tem esse nome). */
  cadastrar(nome: string, embedding: number[]): VozConhecida {
    const limpo = nome.trim().slice(0, 40);
    if (!limpo) throw new Error('falta o nome');
    const agora = Date.now();
    let v = this.vozes.find((x) => norm(x.nome) === norm(limpo));
    if (v) {
      v.amostras = [...v.amostras, embedding].slice(-MAX_AMOSTRAS);
      v.atualizadaEm = agora;
    } else {
      v = { id: randomUUID(), nome: limpo, amostras: [embedding], criadaEm: agora, atualizadaEm: agora };
      this.vozes.push(v);
      this.log.log(`Voz nova no banco: ${limpo}`);
    }
    this.save();
    return v;
  }

  /** Reconheceu com folga: guarda mais esta amostra, para o cadastro acompanhar a voz no dia a dia. */
  reforcar(r: Reconhecimento, embedding: number[]): void {
    if (r.score < REFORCA) return;
    const v = this.vozes.find((x) => x.id === r.id);
    if (!v) return;
    v.amostras = [...v.amostras, embedding].slice(-MAX_AMOSTRAS);
    v.atualizadaEm = Date.now();
    this.save();
  }

  /** Chegou uma voz que ele não tem certeza de quem é: fica guardada para salvar_voz. */
  guardarPendente(embedding: number[]): void {
    this.pendente = { embedding, at: Date.now() };
  }

  /** A pessoa disse o nome: a voz pendente entra no banco. Null se não há voz esperando. */
  salvarPendente(nome: string): VozConhecida | null {
    if (!this.pendente || Date.now() - this.pendente.at > PENDENTE_MS) return null;
    const v = this.cadastrar(nome, this.pendente.embedding);
    this.pendente = null;
    return v;
  }

  /** Já tem voz com esse nome? */
  conhece(nome: string): boolean {
    return this.vozes.some((v) => norm(v.nome) === norm(nome));
  }

  /** O nome foi salvo errado ("Gui" no lugar de "Jean"): corrige. Se o nome certo já existe, junta as duas. */
  renomear(atual: string, certo: string): VozConhecida | null {
    const v = this.vozes.find((x) => norm(x.nome) === norm(atual));
    const limpo = certo.trim().slice(0, 40);
    if (!v || !limpo) return null;
    const outra = this.vozes.find((x) => x !== v && norm(x.nome) === norm(limpo));
    if (outra) {
      outra.amostras = [...outra.amostras, ...v.amostras].slice(-MAX_AMOSTRAS);
      outra.atualizadaEm = Date.now();
      this.vozes = this.vozes.filter((x) => x !== v);
      this.save();
      return outra;
    }
    v.nome = limpo;
    v.atualizadaEm = Date.now();
    this.save();
    this.log.log(`Voz renomeada: ${atual} → ${limpo}`);
    return v;
  }

  /** "Esquece a minha voz" — pelo nome. */
  removerPorNome(nome: string): boolean {
    const v = this.vozes.find((x) => norm(x.nome) === norm(nome));
    return v ? this.remover(v.id) : false;
  }

  remover(id: string): boolean {
    const antes = this.vozes.length;
    this.vozes = this.vozes.filter((v) => v.id !== id);
    if (this.vozes.length === antes) return false;
    this.save();
    this.log.log('Voz apagada do banco');
    return true;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.vozes));
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`Falha ao salvar o banco de vozes: ${(err as Error).message}`);
    }
  }
}

export function cosseno(a: number[], b: number[]): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    d += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

function media(vs: number[][]): number[] {
  const m = new Array<number>(vs[0]?.length ?? 0).fill(0);
  for (const v of vs) for (let i = 0; i < m.length; i++) m[i]! += v[i]! / vs.length;
  return m;
}
