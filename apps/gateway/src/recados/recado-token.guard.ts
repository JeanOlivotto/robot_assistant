import { ForbiddenException, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { RecadosAppsService } from './recados-apps.service.js';

/** A requisição de uma aplicação autenticada: qual delas mandou o recado. */
export type RequestDeApp = Request & { recadoApp?: string };

/** `Authorization: Bearer <chave da aplicação>` (gerada no app, em Ajustes). Marca na requisição qual aplicação é. */
@Injectable()
export class RecadoTokenGuard implements CanActivate {
  constructor(private readonly apps: RecadosAppsService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RequestDeApp>();
    const app = this.apps.autenticar((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    if (!app) throw new UnauthorizedException();
    if (!app.ativo) throw new ForbiddenException(`a aplicação ${app.nome} está desativada no Miro`);
    req.recadoApp = app.nome;
    return true;
  }
}
