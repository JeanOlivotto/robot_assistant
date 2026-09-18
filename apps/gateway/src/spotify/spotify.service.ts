import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BehaviorSubject } from 'rxjs';
import { LIMITS, utf8Bytes } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

const SCOPE = 'user-read-currently-playing user-read-playback-state';
const AUTH = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

export interface MusicState {
  playing: boolean;
  title: string;
  artist: string;
}
const NOTHING: MusicState = { playing: false, title: '', artist: '' };

export class SpotifyError extends Error {}

/** Corta em bytes UTF-8 sem quebrar caractere (limites do firmware). */
function clamp(s: string, maxBytes: number): string {
  let out = '';
  let used = 0;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out;
}

/**
 * Mostra no robô o que o dono está ouvindo no Spotify. Pergunta "tocando agora" de tempos em tempos
 * e publica o estado; o DeviceGateway repassa. Autoriza uma vez (OAuth) e guarda o refresh token.
 */
@Injectable()
export class SpotifyService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SpotifyService.name);
  private readonly file: string;
  private refreshToken = '';
  private accessToken = '';
  private accessExp = 0;
  private timer?: NodeJS.Timeout;
  readonly music$ = new BehaviorSubject<MusicState>(NOTHING);

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.file = rootPath(`${cfg.DATA_DIR}/spotify.json`);
  }

  get configured(): boolean {
    return !!(this.cfg.SPOTIFY_CLIENT_ID && this.cfg.SPOTIFY_CLIENT_SECRET);
  }

  get connected(): boolean {
    return !!this.refreshToken;
  }

  onModuleInit(): void {
    if (!this.configured) {
      this.log.log('Spotify sem CLIENT_ID/SECRET — integração desligada');
      return;
    }
    try {
      this.refreshToken = (JSON.parse(readFileSync(this.file, 'utf8')) as { refresh_token?: string }).refresh_token ?? '';
    } catch {
      /* ainda não autorizado */
    }
    if (this.connected) {
      this.log.log('Spotify conectado — acompanhando o que toca');
      this.timer = setInterval(() => void this.poll(), this.cfg.SPOTIFY_POLL_SEC * 1000);
      void this.poll();
    } else {
      this.log.log('Spotify configurado, falta autorizar (abra /api/spotify/login)');
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** URL para o dono autorizar o robô a ver o que ele ouve. */
  authorizeUrl(state: string): string {
    const p = new URLSearchParams({
      client_id: this.cfg.SPOTIFY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: this.cfg.SPOTIFY_REDIRECT_URI,
      scope: SCOPE,
      state,
    });
    return `${AUTH}/authorize?${p}`;
  }

  /** Troca o código da autorização pelo refresh token e começa a acompanhar. */
  async exchangeCode(code: string): Promise<void> {
    const data = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.SPOTIFY_REDIRECT_URI,
    });
    if (!data.refresh_token) throw new SpotifyError('Spotify não devolveu refresh_token');
    this.refreshToken = data.refresh_token;
    this.accessToken = data.access_token ?? '';
    this.accessExp = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
    this.save();
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.poll(), this.cfg.SPOTIFY_POLL_SEC * 1000);
    void this.poll();
    this.log.log('Spotify autorizado com sucesso');
  }

  private async token(body: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number }> {
    const basic = Buffer.from(`${this.cfg.SPOTIFY_CLIENT_ID}:${this.cfg.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(`${AUTH}/api/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new SpotifyError(`token falhou (${res.status}): ${(await res.text().catch(() => '')).slice(0, 120)}`);
    return (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  }

  private async access(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessExp) return this.accessToken;
    const data = await this.token({ grant_type: 'refresh_token', refresh_token: this.refreshToken });
    if (!data.access_token) throw new SpotifyError('sem access_token no refresh');
    this.accessToken = data.access_token;
    this.accessExp = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.refreshToken = data.refresh_token; // o Spotify às vezes rotaciona
      this.save();
    }
    return this.accessToken;
  }

  private async poll(): Promise<void> {
    if (!this.connected) return;
    try {
      const token = await this.access();
      const res = await fetch(`${API}/me/player/currently-playing`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 204) return this.emit(NOTHING); // nada tocando
      if (!res.ok) {
        this.log.warn(`currently-playing falhou (${res.status})`);
        return;
      }
      const body = (await res.json()) as {
        is_playing?: boolean;
        item?: { name?: string; artists?: { name?: string }[] } | null;
      };
      if (!body.item) return this.emit(NOTHING);
      this.emit({
        playing: !!body.is_playing,
        title: clamp(body.item.name ?? '', LIMITS.TITLE_MAX_BYTES),
        artist: clamp((body.item.artists ?? []).map((a) => a.name).filter(Boolean).join(', '), LIMITS.SUB_MAX_BYTES),
      });
    } catch (err) {
      this.log.warn(`Spotify poll falhou: ${(err as Error).message}`);
    }
  }

  private emit(next: MusicState): void {
    const cur = this.music$.value;
    if (cur.playing === next.playing && cur.title === next.title && cur.artist === next.artist) return;
    if (next.playing) this.log.log(`Tocando: ${next.title} — ${next.artist}`);
    this.music$.next(next);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ refresh_token: this.refreshToken }), { mode: 0o600 });
    } catch (err) {
      this.log.error(`Falha ao salvar token do Spotify: ${(err as Error).message}`);
    }
  }
}
