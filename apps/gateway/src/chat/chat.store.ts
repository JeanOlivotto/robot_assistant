import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { ChatMessage } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

const MAX_MESSAGES = 500;

/** Histórico da conversa em data/chat.json (Postgres entra depois, seção 11 do doc). */
@Injectable()
export class ChatStore implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ChatStore.name);
  private readonly file: string;
  private messages: ChatMessage[] = [];
  private saveTimer?: NodeJS.Timeout;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/chat.json`);
  }

  onModuleInit(): void {
    try {
      this.messages = z.array(ChatMessage).parse(JSON.parse(readFileSync(this.file, 'utf8')));
      this.log.log(`${this.messages.length} mensagens carregadas de ${this.file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`Histórico ignorado: ${(err as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    if (this.saveTimer) this.flush();
  }

  recent(n: number): ChatMessage[] {
    return this.messages.slice(-n);
  }

  findByProposal(proposalId: string): ChatMessage | undefined {
    return this.messages.find((m) => m.proposal?.id === proposalId);
  }

  pendingProposals(): ChatMessage[] {
    return this.messages.filter((m) => m.proposal?.status === 'pending');
  }

  /** Insere ou substitui (mesmo id). */
  upsert(msg: ChatMessage): void {
    const i = this.messages.findIndex((m) => m.id === msg.id);
    if (i >= 0) this.messages[i] = msg;
    else this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) this.messages = this.messages.slice(-MAX_MESSAGES);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  /** Apaga tudo: o dono pediu para começar uma conversa do zero. */
  clear(): number {
    const had = this.messages.length;
    this.messages = [];
    clearTimeout(this.saveTimer);
    this.flush();
    this.log.log(`Histórico apagado (${had} mensagens)`);
    return had;
  }

  private flush(): void {
    this.saveTimer = undefined;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.messages));
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`Falha ao salvar o histórico: ${(err as Error).message}`);
    }
  }
}
