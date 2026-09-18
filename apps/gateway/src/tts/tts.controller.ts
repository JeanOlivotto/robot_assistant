import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Post, StreamableFile, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { TtsError, TtsService } from './tts.service.js';

const SpeakBody = z.object({ text: z.string().min(1).max(2000) });

@Controller('api/tts')
@UseGuards(AppTokenGuard)
export class TtsController {
  constructor(private readonly tts: TtsService) {}

  /** O app pergunta se há voz no servidor; se não, usa a do próprio aparelho. */
  @Get('status')
  status() {
    const provider = this.tts.provider;
    return { enabled: provider !== null, provider };
  }

  @Post()
  @HttpCode(200)
  async speak(@Body() body: unknown): Promise<StreamableFile> {
    const parsed = SpeakBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('mande {"text": "..."}');
    try {
      const audio = await this.tts.synth(parsed.data.text);
      return new StreamableFile(audio, { type: 'audio/mpeg', length: audio.length });
    } catch (err) {
      if (err instanceof TtsError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }
}
