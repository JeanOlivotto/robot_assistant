import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { tokenEquals } from '../auth/token.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/** Exige `Authorization: Bearer <DEVICE_TOKEN>` — os endpoints expõem títulos da agenda. */
@Injectable()
export class TokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const header = ctx.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    if (!tokenEquals(header.replace(/^Bearer\s+/i, ''), this.cfg.DEVICE_TOKEN)) throw new UnauthorizedException();
    return true;
  }
}
