import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import type { Sistema } from './braco.service.js';

/**
 * Uma ação que o dono autorizou de antemão, cadastrada pelo painel (aba PC): o Miro roda quando
 * ele pede, sem o botão de aprovação. {param} no comando vira argumento (escapado na hora).
 */
export interface AcaoCadastrada {
  id: string;
  /** Identificador que o cérebro usa (gerado da descrição: "abrir_projeto"). */
  nome: string;
  /** O que faz, do jeito que ele escreveu — é o que o cérebro lê para decidir. */
  descricao: string;
  comando: string;
  /** Em que sistema o comando funciona (sh no Linux/Mac, PowerShell no Windows). */
  sistema: Sistema;
  /** Só neste computador (o nome dele); vazio = qualquer um com o mesmo sistema. */
  maquina?: string;
  criadaEm: number;
}

export type NovaAcao = Pick<AcaoCadastrada, 'descricao' | 'comando' | 'sistema' | 'maquina'>;

/** Os {param} do comando, na ordem em que aparecem, sem repetir. */
export function paramsDe(comando: string): string[] {
  return [...new Set([...comando.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))];
}

/** "Abrir o projeto no VS Code" → "abrir_o_projeto_no_vs_code" (até 40 letras). */
export function nomeDe(descricao: string): string {
  const s = descricao
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  return s || 'acao';
}

/** Aspas simples do shell: o argumento vira texto, nunca comando. */
export function escapar(valor: string, sistema: Sistema): string {
  return sistema === 'windows' ? `'${valor.replace(/'/g, "''")}'` : `'${valor.replace(/'/g, `'\\''`)}'`;
}

/** O comando pronto para rodar, com os argumentos no lugar (e escapados). */
export function montar(a: Pick<AcaoCadastrada, 'comando' | 'sistema'>, args: Record<string, string>): string {
  return a.comando.replace(/\{(\w+)\}/g, (_, nome: string) => {
    const v = args[nome];
    if (v === undefined) throw new Error(`falta o argumento "${nome}"`);
    return escapar(v, a.sistema);
  });
}

@Injectable()
export class AcoesService {
  private readonly log = new Logger(AcoesService.name);
  private readonly file: string;
  private acoes: AcaoCadastrada[] = [];

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/acoes.json`);
    try {
      this.acoes = JSON.parse(readFileSync(this.file, 'utf8')) as AcaoCadastrada[];
    } catch {
      /* nenhuma ainda */
    }
  }

  listar(): AcaoCadastrada[] {
    return [...this.acoes].sort((a, b) => a.criadaEm - b.criadaEm);
  }

  /** As que valem para esta máquina: mesmo sistema e (sem máquina fixa ou é ela). */
  para(maquina: string, sistema: Sistema): AcaoCadastrada[] {
    return this.listar().filter((a) => a.sistema === sistema && (!a.maquina || a.maquina === maquina));
  }

  criar(nova: NovaAcao): AcaoCadastrada {
    const a: AcaoCadastrada = { id: randomUUID(), nome: this.nomeLivre(nova.descricao), ...this.limpa(nova), criadaEm: Date.now() };
    this.acoes.push(a);
    this.salvar();
    this.log.log(`Ação cadastrada: ${a.nome} (${a.sistema}${a.maquina ? `, só em ${a.maquina}` : ''})`);
    return a;
  }

  editar(id: string, nova: NovaAcao): AcaoCadastrada | null {
    const a = this.acoes.find((x) => x.id === id);
    if (!a) return null;
    const mudouDescricao = a.descricao !== nova.descricao.trim();
    Object.assign(a, this.limpa(nova));
    if (mudouDescricao) a.nome = this.nomeLivre(a.descricao, id);
    this.salvar();
    return a;
  }

  apagar(id: string): boolean {
    const antes = this.acoes.length;
    this.acoes = this.acoes.filter((a) => a.id !== id);
    if (this.acoes.length === antes) return false;
    this.salvar();
    return true;
  }

  private limpa(n: NovaAcao) {
    return {
      descricao: n.descricao.trim().slice(0, 160),
      comando: n.comando.trim().slice(0, 1000),
      sistema: n.sistema,
      maquina: n.maquina?.trim().slice(0, 60) || undefined,
    };
  }

  /** O nome a partir da descrição, sem repetir o de outra ação (abrir_projeto_2…). */
  private nomeLivre(descricao: string, id?: string): string {
    const base = nomeDe(descricao);
    let nome = base;
    for (let i = 2; this.acoes.some((a) => a.nome === nome && a.id !== id); i++) nome = `${base.slice(0, 37)}_${i}`;
    return nome;
  }

  private salvar(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.acoes, null, 2));
    } catch (err) {
      this.log.error(`Não salvei as ações: ${(err as Error).message}`);
    }
  }
}
