import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

const TTL_MS = 12 * 3600_000;
const MAX_ABERTOS = 20;

export interface Invite {
  token: string;
  titulo: string;
  createdAt: number;
  expiresAt: number;
  /** Reuniões que este convidado gravou — para saber o que veio de fora. */
  meetings: string[];
}

/**
 * Convite para alguém gravar uma reunião no seu lugar: um link com validade que abre só o modo
 * reunião. Quem tem o link consegue gravar e encerrar — não vê o chat, a agenda nem as outras atas.
 */
@Injectable()
export class InviteService {
  private readonly log = new Logger(InviteService.name);
  private readonly file: string;
  private invites: Invite[] = [];

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/convites.json`);
    try {
      this.invites = JSON.parse(readFileSync(this.file, 'utf8')) as Invite[];
    } catch {
      /* primeira vez */
    }
  }

  /** Cria o convite e devolve o link pronto para mandar. */
  create(titulo: string): { token: string; url: string; expiresAt: number } {
    this.sweep();
    const token = randomBytes(24).toString('base64url');
    const now = Date.now();
    this.invites.push({ token, titulo, createdAt: now, expiresAt: now + TTL_MS, meetings: [] });
    this.save();
    this.log.log(`Convite criado para "${titulo || 'reunião'}" (vale ${TTL_MS / 3600_000} h)`);
    return {
      token,
      url: `${this.cfg.PUBLIC_URL.replace(/\/+$/, '')}/?convite=${token}`,
      expiresAt: now + TTL_MS,
    };
  }

  /** Convite válido, ou null se não existe ou já venceu. */
  check(token: string | undefined | null): Invite | null {
    if (!token) return null;
    const found = this.invites.find((i) => i.token === token);
    if (!found) return null;
    if (Date.now() > found.expiresAt) {
      this.log.log('Convite vencido recusado');
      return null;
    }
    return found;
  }

  /** Marca que este convidado gravou tal reunião. */
  note(token: string, meetingId: string): void {
    const inv = this.invites.find((i) => i.token === token);
    if (!inv || inv.meetings.includes(meetingId)) return;
    inv.meetings.push(meetingId);
    this.save();
  }

  /** Os convites em pé, sem expor o token inteiro. */
  list(): { titulo: string; createdAt: number; expiresAt: number; meetings: number }[] {
    this.sweep();
    return this.invites.map((i) => ({
      titulo: i.titulo,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      meetings: i.meetings.length,
    }));
  }

  private sweep(): void {
    const now = Date.now();
    const antes = this.invites.length;
    this.invites = this.invites.filter((i) => i.expiresAt > now).slice(-MAX_ABERTOS);
    if (this.invites.length !== antes) this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.invites));
    } catch (err) {
      this.log.error(`Falha ao salvar os convites: ${(err as Error).message}`);
    }
  }
}
