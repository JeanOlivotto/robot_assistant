import { Controller, Delete, Get, HttpCode, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { BancoVozesService } from './banco.service.js';

/** Quem está no banco de vozes — e apagar a voz de alguém (é dado biométrico: sempre dá para tirar). */
@Controller('api/vozes')
@UseGuards(AppTokenGuard)
export class BancoVozesController {
  constructor(private readonly banco: BancoVozesService) {}

  @Get()
  listar() {
    return this.banco.listar();
  }

  @Delete(':id')
  @HttpCode(200)
  remover(@Param('id') id: string) {
    if (!this.banco.remover(id)) throw new NotFoundException('voz não encontrada');
    return { ok: true };
  }
}
