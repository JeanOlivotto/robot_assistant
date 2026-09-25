import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { AcoesService } from './acoes.service.js';
import { BracoService } from './braco.service.js';

const NovaAcao = z.object({
  descricao: z.string().trim().min(3).max(160),
  comando: z.string().trim().min(1).max(1000),
  sistema: z.enum(['linux', 'windows', 'mac']),
  maquina: z.string().max(60).optional(),
});

/** A aba PC do app: os computadores conectados e as ações que rodam sem pedir aprovação. */
@Controller('api/braco')
@UseGuards(AppTokenGuard)
export class BracoController {
  constructor(
    private readonly braco: BracoService,
    private readonly acoes: AcoesService,
  ) {}

  @Get()
  estado() {
    return {
      maquinas: this.braco.maquinas().map(({ nome, sistema, ativaEm }) => ({ nome, sistema, ativaEm })),
      acoes: this.acoes.listar(),
    };
  }

  @Post('acoes')
  criar(@Body() body: unknown) {
    return this.acoes.criar(this.validar(body));
  }

  @Put('acoes/:id')
  editar(@Param('id') id: string, @Body() body: unknown) {
    const a = this.acoes.editar(id, this.validar(body));
    if (!a) throw new NotFoundException('ação não encontrada');
    return a;
  }

  @Delete('acoes/:id')
  apagar(@Param('id') id: string) {
    if (!this.acoes.apagar(id)) throw new NotFoundException('ação não encontrada');
    return { ok: true };
  }

  private validar(body: unknown) {
    const parsed = NovaAcao.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    return parsed.data;
  }
}
