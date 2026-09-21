import { BadRequestException, Body, Controller, HttpCode, InternalServerErrorException, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { CalendarService } from './calendar.service.js';

const NewEvent = z.object({
  title: z.string().min(1).max(120),
  /** Início em epoch ms — o app manda o horário já resolvido, sem texto para interpretar. */
  start: z.number().int().positive(),
  minutes: z.number().int().min(5).max(12 * 60).default(60),
});

@Controller('api/calendar')
@UseGuards(AppTokenGuard)
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  /**
   * Agenda direto, sem passar pela proposta: aqui quem clicou foi o dono, escolhendo dia e hora
   * na tela da ata. A proposta existe para quando quem sugere é o robô.
   */
  @Post('event')
  @HttpCode(200)
  async create(@Body() body: unknown): Promise<{ title: string; start: number; end: number }> {
    const parsed = NewEvent.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'dados inválidos');
    if (!this.calendar.writable) throw new BadRequestException('a agenda está só para leitura no servidor');

    const { title, start, minutes } = parsed.data;
    const end = start + minutes * 60_000;
    try {
      await this.calendar.createEvent(title, new Date(start), new Date(end));
    } catch (err) {
      throw new InternalServerErrorException((err as Error).message);
    }
    return { title, start, end };
  }
}
