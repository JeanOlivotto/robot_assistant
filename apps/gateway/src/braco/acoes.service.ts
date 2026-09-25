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

/** Computador que já conectou alguma vez: guardado para dar para ligar (Wake-on-LAN) quando está desligado. */
export interface MaquinaConhecida {
  nome: string;
  sistema: Sistema;
  /** Placa de rede com fio de preferência, "aa:bb:cc:dd:ee:ff". */
  mac?: string;
  /** IP e máscara dessa placa na última vez que conectou. */
  rede?: Rede;
  vistaEm: number;
}

export interface Rede {
  ip: string;
  mask: string;
}

const ip32 = (ip: string) => ip.split('.').reduce((n, p) => (n << 8) + (Number(p) & 255), 0) >>> 0;

/** Os dois estão na mesma sub-rede (o broadcast do robô chega no PC)? Null se falta informação. */
export function mesmaRede(a?: Rede, b?: Rede): boolean | null {
  if (!a?.ip || !b?.ip) return null;
  const m = ip32(a.mask || '255.255.255.0');
  return ((ip32(a.ip) & m) >>> 0) === ((ip32(b.ip) & m) >>> 0);
}

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
  private readonly fileMaquinas: string;
  private acoes: AcaoCadastrada[] = [];
  private maquinas: MaquinaConhecida[] = [];

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/acoes.json`);
    this.fileMaquinas = rootPath(`${cfg.DATA_DIR}/maquinas.json`);
    try {
      this.acoes = JSON.parse(readFileSync(this.file, 'utf8')) as AcaoCadastrada[];
    } catch {
      /* nenhuma ainda */
    }
    try {
      this.maquinas = JSON.parse(readFileSync(this.fileMaquinas, 'utf8')) as MaquinaConhecida[];
    } catch {
      /* nenhuma conectou ainda */
    }
  }

  conhecidas(): MaquinaConhecida[] {
    return [...this.maquinas].sort((a, b) => b.vistaEm - a.vistaEm);
  }

  /** Uma máquina conectou: guarda (ou atualiza) o nome, o sistema e o MAC dela. */
  lembrar(m: Omit<MaquinaConhecida, 'vistaEm'>): void {
    const antiga = this.maquinas.find((x) => x.nome === m.nome);
    const nova = { ...antiga, ...m, mac: m.mac ?? antiga?.mac, rede: m.rede ?? antiga?.rede, vistaEm: Date.now() };
    this.maquinas = [...this.maquinas.filter((x) => x.nome !== m.nome), nova];
    this.gravar(this.fileMaquinas, this.maquinas);
  }

  esquecer(nome: string): boolean {
    const antes = this.maquinas.length;
    this.maquinas = this.maquinas.filter((m) => m.nome !== nome);
    if (this.maquinas.length === antes) return false;
    this.gravar(this.fileMaquinas, this.maquinas);
    return true;
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
    this.gravar(this.file, this.acoes);
  }

  private gravar(file: string, dados: unknown): void {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(dados, null, 2));
    } catch (err) {
      this.log.error(`Não salvei ${file}: ${(err as Error).message}`);
    }
  }
}
