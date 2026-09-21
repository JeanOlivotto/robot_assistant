import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { ChatService } from '../chat/chat.service.js';
import { MemoryService } from './memory.service.js';

const ResetBody = z.object({
  /** all = esquece tudo; memories = só os assuntos de longo prazo; chat = só as mensagens. */
  scope: z.enum(['all', 'memories', 'chat']).default('all'),
});

@Controller('api/memory')
@UseGuards(AppTokenGuard)
export class MemoryController {
  constructor(
    private readonly memory: MemoryService,
    private readonly chat: ChatService,
  ) {}

  /** O que o robô lembra hoje. */
  @Get()
  status() {
    return {
      memories: this.memory.all().map((m) => ({ texto: m.texto, mentions: m.mentions, lastSeenAt: m.lastSeenAt })),
      messages: this.chat.history(500).length,
    };
  }

  /** Recomeço do zero — usado quando a personalidade muda e o passado só puxaria o tom antigo. */
  @Post('reset')
  @HttpCode(200)
  reset(@Body() body: unknown) {
    const { scope } = ResetBody.parse(body ?? {});
    const forgot = scope === 'chat' ? 0 : this.memory.clear();
    const erased = scope === 'memories' ? 0 : this.chat.clearHistory();
    return { scope, memoriesForgotten: forgot, messagesErased: erased };
  }
}
