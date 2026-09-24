import { BadRequestException, Body, Controller, Get, HttpCode, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { IdentidadeService } from './identidade.service.js';

const Body_ = z.object({ nome: z.string().trim().min(1).max(30), motivo: z.string().trim().max(160).optional() });

/**
 * O dono também pode dar o nome (e não só o robô escolher): o nome é a palavra que o chama por
 * voz, e ela precisa ser fácil de reconhecer — "Tiber" o Whisper local errava; "Miro" não.
 */
@Controller('api/identidade')
@UseGuards(AppTokenGuard)
export class IdentidadeController {
  constructor(private readonly identidade: IdentidadeService) {}

  @Get()
  ler() {
    return { nome: this.identidade.nome, escolheuNome: this.identidade.escolheuNome, sobre: this.identidade.sobre };
  }

  @Put()
  @HttpCode(200)
  definir(@Body() body: unknown) {
    const p = Body_.safeParse(body ?? {});
    if (!p.success) throw new BadRequestException(z.prettifyError(p.error));
    try {
      this.identidade.definirNome(p.data.nome);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    if (p.data.motivo) this.identidade.lembrarDeMim(`nome: ${p.data.nome} — ${p.data.motivo}`);
    return this.ler();
  }
}
