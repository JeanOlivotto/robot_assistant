import { Controller, Get, HttpCode, Inject, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { tokenEquals } from '../auth/token.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/** O webapp confere a senha aqui antes de abrir o WebSocket (um upgrade recusado não diz o motivo). */
@Controller('api')
export class AppAuthController {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  @Get('session')
  @HttpCode(204)
  session(@Req() req: Request): void {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!tokenEquals(token, this.cfg.APP_TOKEN)) throw new UnauthorizedException();
  }
}
