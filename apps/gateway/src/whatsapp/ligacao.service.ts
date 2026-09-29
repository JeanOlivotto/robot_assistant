import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { ChatService } from '../chat/chat.service.js';
import { type Ligacao, WhatsappService } from './whatsapp.service.js';

/**
 * Ligação no WhatsApp: o servidor não entra nela (o áudio não chega aqui), mas avisa o dono e
 * oferece gravar como reunião. Com o "Grava", o app do computador grava o som do PC — a ligação
 * precisa ser atendida lá. Quando ela acaba, a gravação encerra e a ata sai como numa reunião.
 */
@Injectable()
export class LigacaoService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LigacaoService.name);
  /** O mesmo "chegando" pode vir mais de uma vez (outro aparelho, reconexão): um cartão só. */
  private readonly avisadas = new Set<string>();
  private sub?: Subscription;

  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly chat: ChatService,
  ) {}

  onModuleInit(): void {
    this.sub = this.whatsapp.ligacao$.subscribe((l) => this.aoLigar(l));
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  private aoLigar(l: Ligacao): void {
    if (l.fase === 'acabou') return this.chat.ligacaoAcabou(l.id);
    if (this.avisadas.has(l.id)) return;
    this.avisadas.add(l.id);
    if (this.avisadas.size > 100) this.avisadas.delete(this.avisadas.values().next().value!);

    const tipo = l.video ? 'uma chamada de vídeo' : 'uma ligação';
    const quem = l.grupo ? `O grupo ${l.nome} está fazendo ${tipo}` : `${l.nome} está te ligando${l.video ? ' (vídeo)' : ''}`;
    this.log.log(`Ligação no WhatsApp: ${l.grupo ? `grupo ${l.nome}` : l.nome}`);
    this.chat.robotSay(`📞 ${quem} no WhatsApp. Quer que eu grave e faça a ata? Atende pelo PC.`, 'surprised', 'whatsapp', {
      proposal: { id: randomUUID(), kind: 'reuniao', title: `Ligação com ${l.nome}`, ligacao: l.id, status: 'pending' },
      expectsReply: true,
    });
  }
}
