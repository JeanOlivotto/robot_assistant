import { BadRequestException, Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AlertService } from '../alerts/alert.service.js';
import { CalendarService } from '../calendar/calendar.service.js';
import { ChatService } from '../chat/chat.service.js';
import { DeviceGateway } from '../device/device.gateway.js';
import { ProactiveService } from '../proactive/proactive.service.js';
import { TokenGuard } from './token.guard.js';

const ProactiveBody = z.object({ kind: z.enum(['morning', 'evening', 'attention']) });

const TestAlertBody = z.object({
  title: z.string().min(1).default('Compromisso de teste'),
  in_min: z.number().int().min(0).max(120).default(10),
  ttl_s: z.number().int().min(5).max(600).default(30),
});

@Controller()
export class DebugController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly alerts: AlertService,
    private readonly devices: DeviceGateway,
    private readonly chat: ChatService,
    private readonly proactiveSvc: ProactiveService,
  ) {}

  /** Público: não expõe títulos. */
  @Get('health')
  health() {
    return {
      ok: true,
      revision: process.env.GIT_SHA ?? 'dev',
      now: new Date().toISOString(),
      devices: this.devices.list().length,
      calendar: this.calendar.status,
    };
  }

  @Get('devices')
  @UseGuards(TokenGuard)
  listDevices() {
    return this.devices.list();
  }

  @Get('agenda')
  @UseGuards(TokenGuard)
  agenda() {
    return this.calendar.agenda$.value.map((i) => ({
      ...i,
      start: new Date(i.start).toISOString(),
      end: new Date(i.end).toISOString(),
    }));
  }

  @Post('debug/alert')
  @UseGuards(TokenGuard)
  testAlert(@Body() body: unknown) {
    const parsed = TestAlertBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    const { title, in_min, ttl_s } = parsed.data;
    return this.alerts.test(title, in_min, ttl_s);
  }

  @Post('debug/refresh')
  @HttpCode(202)
  @UseGuards(TokenGuard)
  async refresh() {
    await this.calendar.refresh();
    return this.calendar.status;
  }

  /** Dispara agora uma mensagem proativa (sem esperar o horário). */
  @Post('debug/proactive')
  @HttpCode(202)
  @UseGuards(TokenGuard)
  async proactive(@Body() body: unknown) {
    const parsed = ProactiveBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    await this.proactiveSvc.trigger(parsed.data.kind);
    return { ok: true };
  }

  /** Fala com o robô como se fosse o dono no webapp (para testar pelo terminal). */
  @Post('debug/say')
  @HttpCode(202)
  @UseGuards(TokenGuard)
  async say(@Body() body: unknown) {
    const parsed = z.object({ text: z.string().min(1) }).safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    await this.chat.say(parsed.data.text);
    return this.chat.history(2);
  }
}
