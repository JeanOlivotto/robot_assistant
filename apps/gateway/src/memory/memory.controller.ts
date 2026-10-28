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

  /** O grafo da memória (entidades e ligações), para o app desenhar. */
  @Get('grafo')
  grafo() {
    const { entidades, relacoes } = this.memory.grafo();
    return {
      dono: this.memory.nomeDoDono(),
      entidades: entidades.map((e) => ({ id: e.id, nome: e.texto, tipo: e.tipo, apelidos: e.apelidos, mentions: e.mentions, lastSeenAt: e.lastSeenAt })),
      relacoes: relacoes.map((r) => ({ de: r.de, rel: r.rel, para: r.para, valor: r.valor })),
    };
  }

  /** Apaga as lembranças de um assunto (o mesmo que a ferramenta esquecer_assunto faz na conversa). */
  @Post('forget')
  @HttpCode(200)
  forget(@Body() body: unknown) {
    const { assunto } = z.object({ assunto: z.string().min(1) }).parse(body ?? {});
    return { forgotten: this.memory.esquecer(assunto) };
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
