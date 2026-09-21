import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { tokenEquals } from '../auth/token.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { InviteService } from './invite.service.js';

/** O convidado que está gravando esta requisição (vazio quando é o próprio dono). */
export interface GuestRequest extends Request {
  guestToken?: string;
}

/**
 * Deixa passar o dono (APP_TOKEN) ou um convidado com link válido. Vale só nas rotas de gravar:
 * a lista de atas e o conteúdo delas continuam atrás do AppTokenGuard.
 */
@Injectable()
export class MeetingAccessGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly invites: InviteService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<GuestRequest>();
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (tokenEquals(bearer, this.cfg.APP_TOKEN)) return true;

    const convite = this.invites.check(bearer);
    if (!convite) throw new UnauthorizedException();
    req.guestToken = convite.token;
    return true;
  }
}
