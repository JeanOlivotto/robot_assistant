import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/** Uma chamada dura no máximo isso; depois o id não vale mais (o app abre outra). */
const TTL_MS = 2 * 3600_000;
const MAX_SESSIONS = 20;

/** Aberturas curtas: o robô nunca repete a última fala do chat ao atender. */
const GREETINGS = ['Oi{,nome}!', 'Fala{,nome}!', 'Opa, pode falar!', 'Oi! Tô aqui.', 'Tô ouvindo!', 'E aí{,nome}?'];

/**
 * Cada vez que o dono abre o modo chamada começa uma conversa NOVA: o cérebro só enxerga o que
 * for falado desta hora em diante. A memória de longo prazo (lembrancas.json) continua valendo —
 * ela entra pelo prompt, não pelo histórico.
 */
@Injectable()
export class VoiceSessionService {
  private readonly log = new Logger(VoiceSessionService.name);
  private readonly sessions = new Map<string, number>();

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** Abre uma chamada. `startedAt` é o corte do histórico; `greeting` é a fala de abertura. */
  start(): { id: string; startedAt: number; greeting: string } {
    this.sweep();
    const id = randomUUID();
    const startedAt = Date.now();
    this.sessions.set(id, startedAt);
    this.log.log(`Chamada ${id.slice(0, 8)} aberta — conversa nova`);
    return { id, startedAt, greeting: this.greeting() };
  }

  /** Desde quando vale o histórico desta chamada (undefined = chamada desconhecida/vencida). */
  since(id?: string): number | undefined {
    if (!id) return undefined;
    const at = this.sessions.get(id);
    if (at === undefined) return undefined;
    if (Date.now() - at > TTL_MS) {
      this.sessions.delete(id);
      return undefined;
    }
    return at;
  }

  private greeting(): string {
    const nome = (this.cfg.OWNER_NAME || '').trim().split(/\s+/)[0] ?? '';
    const pick = GREETINGS[Math.floor(Math.random() * GREETINGS.length)]!;
    return pick.replace('{,nome}', nome ? `, ${nome}` : '');
  }

  private sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, at] of this.sessions) if (at < cutoff) this.sessions.delete(id);
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1] - b[1])[0];
      if (!oldest) break;
      this.sessions.delete(oldest[0]);
    }
  }
}
