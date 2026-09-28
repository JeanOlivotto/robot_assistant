import { BadRequestException, Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { AtendenteService } from './atendente.service.js';
import { WhatsappService } from './whatsapp.service.js';

const Atender = z.object({ ligar: z.boolean() });

const Privacidade = z.object({
  ligar: z.boolean(),
  horas: z.number().positive().max(720).optional(),
});

/** Aba PC do app: parear pelo QR, ver se está conectado, ligar a privacidade na mão. */
@Controller('api/whatsapp')
@UseGuards(AppTokenGuard)
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly atendente: AtendenteService,
  ) {}

  @Get()
  status() {
    return { ...this.whatsapp.status(), ultimoChamado: this.atendente.ultimo };
  }

  @Post('conectar')
  @HttpCode(200)
  async conectar() {
    await this.whatsapp.conectar();
    return this.whatsapp.status();
  }

  @Post('desconectar')
  @HttpCode(200)
  async desconectar() {
    await this.whatsapp.desconectar();
    return this.whatsapp.status();
  }

  /** Quem chama o robô pelo nome no WhatsApp conversa com ele (só conversa) — liga e desliga. */
  @Post('atender')
  @HttpCode(200)
  atender(@Body() body: unknown) {
    const parsed = Atender.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    this.whatsapp.definirAtender(parsed.data.ligar);
    return this.whatsapp.status();
  }

  @Post('privacidade')
  @HttpCode(200)
  privacidade(@Body() body: unknown) {
    const parsed = Privacidade.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    this.whatsapp.definirPrivacidade(parsed.data.ligar, parsed.data.horas);
    return this.whatsapp.status();
  }
}
