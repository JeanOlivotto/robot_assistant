import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import webpush, { type PushSubscription } from 'web-push';
import { AppGateway } from '../chat/app.gateway.js';
import { ChatService } from '../chat/chat.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { IdentidadeService } from '../identidade/identidade.service.js';
import { rootPath } from '../config/paths.js';

interface StoredSubscription extends PushSubscription {
  createdAt: number;
  ua?: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Mesma tag = a notificação nova substitui a anterior. */
  tag?: string;
  url?: string;
}

/**
 * Notificação no celular (Web Push; no iPhone, com o app na Tela de Início).
 * Vai: o que o robô manda sozinho, lembretes e respostas quando ninguém está com o app aberto.
 */
@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PushService.name);
  private readonly file: string;
  private subs: StoredSubscription[] = [];
  private sub?: Subscription;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly chat: ChatService,
    private readonly app: AppGateway,
    private readonly identidade: IdentidadeService,
  ) {
    this.file = rootPath(`${cfg.DATA_DIR}/push.json`);
  }

  get enabled(): boolean {
    return !!(this.cfg.VAPID_PUBLIC_KEY && this.cfg.VAPID_PRIVATE_KEY);
  }

  get publicKey(): string {
    return this.cfg.VAPID_PUBLIC_KEY;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.log.warn('Sem VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY — notificações push desligadas');
      return;
    }
    webpush.setVapidDetails(this.cfg.VAPID_SUBJECT, this.cfg.VAPID_PUBLIC_KEY, this.cfg.VAPID_PRIVATE_KEY);
    try {
      this.subs = JSON.parse(readFileSync(this.file, 'utf8')) as StoredSubscription[];
    } catch {
      /* ninguém inscrito ainda */
    }
    this.log.log(`Push ativo (${this.subs.length} aparelho(s) inscrito(s))`);

    this.sub = this.chat.said$.subscribe(({ message, replyVia }) => {
      const kind = message.kind ?? 'reply';
      // Resposta: só se ninguém está olhando o app, e nunca para a Siri (ela já falou em voz alta).
      if (kind === 'reply' && (replyVia === 'siri' || this.app.anyVisible)) return;
      void this.notify({
        title: kind === 'reminder' ? 'Lembrete' : kind === 'meeting' ? 'Reunião' : this.identidade.nome, // o nome que ele escolheu
        body: message.text,
        tag: kind === 'reminder' ? `lembrete-${message.id}` : kind === 'meeting' ? `reuniao-${message.id}` : 'conversa',
        url: '/',
      });
    });
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  add(sub: PushSubscription, ua?: string): void {
    this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint);
    this.subs.push({ ...sub, createdAt: Date.now(), ua });
    this.save();
    this.log.log(`Aparelho inscrito (${this.subs.length} no total)`);
  }

  remove(endpoint: string): void {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.save();
  }

  async notify(p: PushPayload): Promise<number> {
    if (!this.enabled || !this.subs.length) return 0;
    const body = p.body.length > 180 ? `${p.body.slice(0, 177)}…` : p.body;
    const payload = JSON.stringify({ ...p, body });
    let sent = 0;
    for (const s of [...this.subs]) {
      try {
        await webpush.sendNotification(s, payload, { TTL: 3600, urgency: 'high' });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          this.log.log('Inscrição expirada removida');
          this.remove(s.endpoint);
        } else {
          this.log.warn(`Push falhou (${status ?? '?'}): ${(err as Error).message}`);
        }
      }
    }
    return sent;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.subs), { mode: 0o600 });
    } catch (err) {
      this.log.error(`Falha ao salvar inscrições: ${(err as Error).message}`);
    }
  }
}
