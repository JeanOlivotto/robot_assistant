import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { TaskService } from './task.service.js';

const NewTask = z.object({
  texto: z.string().min(3).max(160),
  pessoa: z.string().max(40).optional(),
});

@Controller('api/tasks')
@UseGuards(AppTokenGuard)
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  @Get()
  list() {
    return this.tasks.all();
  }

  @Post()
  @HttpCode(200)
  add(@Body() body: unknown) {
    const parsed = NewTask.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    const t = this.tasks.add(parsed.data.texto, { pessoa: parsed.data.pessoa, origem: 'manual' });
    if (!t) throw new BadRequestException('texto curto demais');
    return t;
  }

  @Post(':id/done')
  @HttpCode(200)
  done(@Param('id') id: string) {
    const t = this.tasks.done(id);
    if (!t) throw new NotFoundException('pendência não encontrada');
    return t;
  }

  @Post(':id/drop')
  @HttpCode(200)
  drop(@Param('id') id: string) {
    if (!this.tasks.drop(id)) throw new NotFoundException('pendência não encontrada');
    return { ok: true };
  }
}
