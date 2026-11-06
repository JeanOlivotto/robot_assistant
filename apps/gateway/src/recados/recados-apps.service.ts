import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

/** Uma aplicação que pode deixar recado. O token em si nunca é guardado — só o hash. */
export interface AppRecados {
  nome: string;
  /** sha256 do token (hex). */
  hash: string;
  /** Começo do token ("rcd_Ab12…"), para reconhecer qual chave está em uso. */
  prefixo: string;
  ativo: boolean;
  criadoEm: number;
  tokenEm: number;
  /** /health que o robô sonda (vazio = sem sonda). */
  saudeUrl?: string;
  ultimoRecadoEm?: number;
  recebidos: number;
}

/** O que o app web vê (sem o hash). */
export type AppPublica = Omit<AppRecados, 'hash'>;

export const NOME_APP = /^[a-z0-9][a-z0-9-]{0,30}$/;
const url = z
  .string()
  .trim()
  .max(500)
  .regex(/^https?:\/\/\S+$/, 'a URL precisa começar com http:// ou https://');

export const NovaApp = z.object({
  nome: z.string().trim().regex(NOME_APP, 'nome em minúsculas, sem espaço (ex.: baixaxml)'),
  saudeUrl: url.or(z.literal('')).optional(),
});
export const MudarApp = z.object({
  ativo: z.boolean().optional(),
  saudeUrl: url.or(z.literal('')).optional(),
});

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** As aplicações cadastradas pelo app web, com as chaves de API delas. */
@Injectable()
export class RecadosAppsService {
  private readonly log = new Logger(RecadosAppsService.name);
  private readonly file: string;
  private apps: AppRecados[] = [];

  /** `DATA_DIR` vazio = só em memória (testes). */
  constructor(@Inject(APP_CONFIG) cfg: Pick<AppConfig, 'DATA_DIR'>) {
    this.file = cfg.DATA_DIR ? rootPath(`${cfg.DATA_DIR}/recados-apps.json`) : '';
    if (!this.file) return;
    try {
      this.apps = JSON.parse(readFileSync(this.file, 'utf8')) as AppRecados[];
    } catch {
      /* nenhuma ainda */
    }
  }

  listar(): AppPublica[] {
    return this.apps.map(({ hash: _, ...pub }) => pub);
  }

  get(nome: string): AppPublica | undefined {
    return this.listar().find((a) => a.nome === nome);
  }

  /** Cria e devolve o token — a única vez que ele aparece. */
  criar(nome: string, saudeUrl?: string, now = Date.now()): { app: AppPublica; token: string } | { erro: string } {
    if (this.apps.some((a) => a.nome === nome)) return { erro: `já existe uma aplicação "${nome}"` };
    const token = novoToken();
    const app: AppRecados = {
      nome,
      hash: hash(token),
      prefixo: token.slice(0, 8),
      ativo: true,
      criadoEm: now,
      tokenEm: now,
      ...(saudeUrl ? { saudeUrl } : {}),
      recebidos: 0,
    };
    this.apps.push(app);
    this.save();
    this.log.log(`Aplicação de recados criada: ${nome}`);
    return { app: this.get(nome)!, token };
  }

  /** Chave nova; a antiga para de valer na hora. */
  novaChave(nome: string, now = Date.now()): string | null {
    const app = this.apps.find((a) => a.nome === nome);
    if (!app) return null;
    const token = novoToken();
    app.hash = hash(token);
    app.prefixo = token.slice(0, 8);
    app.tokenEm = now;
    this.save();
    this.log.log(`Chave nova para ${nome}`);
    return token;
  }

  mudar(nome: string, m: z.infer<typeof MudarApp>): AppPublica | null {
    const app = this.apps.find((a) => a.nome === nome);
    if (!app) return null;
    if (m.ativo !== undefined) app.ativo = m.ativo;
    if (m.saudeUrl !== undefined) {
      if (m.saudeUrl) app.saudeUrl = m.saudeUrl;
      else delete app.saudeUrl;
    }
    this.save();
    return this.get(nome)!;
  }

  apagar(nome: string): boolean {
    const antes = this.apps.length;
    this.apps = this.apps.filter((a) => a.nome !== nome);
    if (this.apps.length === antes) return false;
    this.save();
    this.log.log(`Aplicação de recados apagada: ${nome}`);
    return true;
  }

  /** De quem é este token. Compara com todas (sem parar na primeira), para o tempo não entregar nada. */
  autenticar(token: string): AppPublica | null {
    if (!token) return null;
    const dado = Buffer.from(hash(token), 'hex');
    let achada: AppRecados | undefined;
    for (const a of this.apps) {
      if (timingSafeEqual(dado, Buffer.from(a.hash, 'hex'))) achada = a;
    }
    return achada ? this.get(achada.nome)! : null;
  }

  registrarRecado(nome: string, now = Date.now()): void {
    const app = this.apps.find((a) => a.nome === nome);
    if (!app) return;
    app.ultimoRecadoEm = now;
    app.recebidos += 1;
    this.save();
  }

  /** As que o robô sonda: ativas e com URL de saúde. */
  vigiadas(): { app: string; url: string }[] {
    return this.apps.filter((a) => a.ativo && a.saudeUrl).map((a) => ({ app: a.nome, url: a.saudeUrl! }));
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.apps), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`Falha ao salvar aplicações de recados: ${(err as Error).message}`);
    }
  }
}

/** "rcd_" + 32 bytes aleatórios em base64url. */
function novoToken(): string {
  return `rcd_${randomBytes(32).toString('base64url')}`;
}
