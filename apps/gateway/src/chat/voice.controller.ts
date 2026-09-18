import { BadRequestException, Body, Controller, HttpCode, HttpException, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { SttError, SttService } from '../stt/stt.service.js';
import { ChatService } from './chat.service.js';

const AskBody = z.object({ text: z.string().trim().min(1).max(2000) });

/** Tira emoji e espaços sobrando — a Siri lê emoji em voz alta ("rosto sorridente..."). */
function forSpeech(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

@Controller('api')
@UseGuards(AppTokenGuard)
export class VoiceController {
  constructor(
    private readonly stt: SttService,
    private readonly chat: ChatService,
  ) {}

  /** Mensagem de voz do webapp: áudio no corpo (AAC do iPhone, Opus, WAV). A resposta chega pelo WebSocket. */
  @Post('voice')
  async voice(@Body() audio: unknown): Promise<{ text: string; seconds: number }> {
    if (!Buffer.isBuffer(audio) || !audio.length) throw new BadRequestException('mande o áudio no corpo (Content-Type audio/*)');
    try {
      const { text, seconds } = await this.stt.transcribe(audio);
      if (!text) throw new SttError('não entendi nada nesse áudio', 422);
      void this.chat.say(text, 'voice');
      return { text, seconds };
    } catch (err) {
      if (err instanceof SttError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  /** Atalho da Siri: texto ditado entra, resposta pronta para ser falada sai. */
  @Post('ask')
  @HttpCode(200)
  async ask(@Body() body: unknown): Promise<{ reply: string; face: string }> {
    const parsed = AskBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('mande {"text": "..."}');
    const reply = await this.chat.ask(parsed.data.text, 'siri');
    return {
      reply: reply ? forSpeech(reply.text) : 'Hmm, não tenho nada pra dizer agora.',
      face: reply?.face ?? 'neutral',
    };
  }
}
