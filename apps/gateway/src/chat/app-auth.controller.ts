import { Controller, Get, HttpCode, UseGuards } from '@nestjs/common';
import { AppTokenGuard } from '../auth/app-token.guard.js';

/** O webapp confere a senha aqui antes de abrir o WebSocket (um upgrade recusado não diz o motivo). */
@Controller('api')
export class AppAuthController {
  @Get('session')
  @HttpCode(204)
  @UseGuards(AppTokenGuard)
  session(): void {}
}
