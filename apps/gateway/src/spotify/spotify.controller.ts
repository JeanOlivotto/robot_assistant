import { randomBytes } from 'node:crypto';
import { BadRequestException, Controller, Get, Inject, Query, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { tokenEquals } from '../auth/token.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { SpotifyService } from './spotify.service.js';

const page = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<body style="font-family:system-ui;background:#0b0e14;color:#e8ecf3;display:grid;place-items:center;height:100vh;margin:0;text-align:center">` +
  `<div><div style="font-size:42px">🎧</div><p style="font-size:18px;max-width:320px;padding:0 16px">${msg}</p></div>`;

@Controller('api/spotify')
export class SpotifyController {
  private state = '';

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly spotify: SpotifyService,
  ) {}

  @Get('status')
  status() {
    return { configured: this.spotify.configured, connected: this.spotify.connected, now: this.spotify.music$.value };
  }

  /** O dono abre isto (com ?k=SENHA) para autorizar o robô a ver o que ele ouve. */
  @Get('login')
  login(@Query('k') k: string | undefined, @Res() res: Response) {
    if (!tokenEquals(k ?? '', this.cfg.APP_TOKEN)) throw new UnauthorizedException('use ?k=SUA_SENHA');
    if (!this.spotify.configured) throw new BadRequestException('faltam SPOTIFY_CLIENT_ID/SECRET no servidor');
    this.state = randomBytes(12).toString('hex');
    res.redirect(this.spotify.authorizeUrl(this.state));
  }

  /** O Spotify manda o dono de volta para cá com o código. */
  @Get('callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Res() res: Response) {
    if (!code || !state || state !== this.state) {
      res.status(400).type('html').send(page('Autorização inválida ou expirada. Tente abrir o link de novo.'));
      return;
    }
    this.state = '';
    try {
      await this.spotify.exchangeCode(code);
      res.type('html').send(page('Prontinho! O robô já está de olho no que você ouve. Pode fechar. 🎶'));
    } catch (err) {
      res.status(502).type('html').send(page(`Deu ruim ao conectar: ${(err as Error).message}`));
    }
  }
}
