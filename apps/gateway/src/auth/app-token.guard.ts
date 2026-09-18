import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { tokenEquals } from './token.js';

/** `Authorization: Bearer <APP_TOKEN>` — a senha do webapp (e do atalho da Siri). */
@Injectable()
export class AppTokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const header = ctx.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    if (!tokenEquals(header.replace(/^Bearer\s+/i, ''), this.cfg.APP_TOKEN)) throw new UnauthorizedException();
    return true;
  }
}
