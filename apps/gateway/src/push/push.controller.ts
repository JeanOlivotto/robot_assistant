import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { PushService } from './push.service.js';

const SubscriptionBody = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
});

@Controller('api/push')
@UseGuards(AppTokenGuard)
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('key')
  key() {
    return { enabled: this.push.enabled, publicKey: this.push.publicKey };
  }

  @Post('subscribe')
  @HttpCode(204)
  subscribe(@Body() body: unknown, @Headers('user-agent') ua?: string): void {
    if (!this.push.enabled) throw new ServiceUnavailableException('push desligado no servidor');
    const parsed = SubscriptionBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    this.push.add(parsed.data.subscription, ua);
  }

  @Post('unsubscribe')
  @HttpCode(204)
  unsubscribe(@Body() body: unknown): void {
    const endpoint = (body as { endpoint?: unknown } | undefined)?.endpoint;
    if (typeof endpoint === 'string') this.push.remove(endpoint);
  }

  /** Manda uma notificação de teste para todos os aparelhos inscritos. */
  @Post('test')
  async test() {
    const sent = await this.push.notify({ title: 'Miro', body: 'Oi! As notificações estão funcionando 🤖', tag: 'teste' });
    return { sent };
  }
}
