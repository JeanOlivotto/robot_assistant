import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Param, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { MeetingError, MeetingService, type Meeting } from './meeting.service.js';

const StartBody = z.object({ titulo: z.string().max(120).optional() });

/** Uma reunião sem a transcrição inteira, para as listagens não ficarem pesadas. */
function slim(m: Meeting) {
  const { transcript, ...rest } = m;
  return { ...rest, chars: transcript.length };
}

@Controller('api/meeting')
@UseGuards(AppTokenGuard)
export class MeetingController {
  constructor(private readonly meetings: MeetingService) {}

  @Get('status')
  status() {
    return { ready: this.meetings.ready };
  }

  @Post('start')
  @HttpCode(200)
  start(@Body() body: unknown) {
    if (!this.meetings.ready) throw new ServiceUnavailableException('modo reunião indisponível (falta STT ou LLM)');
    const parsed = StartBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    return slim(this.meetings.start(parsed.data.titulo));
  }

  @Post(':id/segment')
  @HttpCode(200)
  async segment(@Param('id') id: string, @Body() audio: unknown) {
    if (!Buffer.isBuffer(audio) || !audio.length) throw new BadRequestException('mande o áudio no corpo (Content-Type audio/*)');
    try {
      return await this.meetings.addSegment(id, audio);
    } catch (err) {
      throw toHttp(err);
    }
  }

  @Post(':id/stop')
  @HttpCode(200)
  async stop(@Param('id') id: string) {
    try {
      return await this.meetings.stop(id);
    } catch (err) {
      throw toHttp(err);
    }
  }

  @Get('list')
  list() {
    return this.meetings.list().map(slim);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const m = this.meetings.get(id);
    if (!m) throw new HttpException('reunião não encontrada', 404);
    return m;
  }
}

function toHttp(err: unknown): HttpException {
  if (err instanceof MeetingError) return new HttpException(err.message, err.status);
  if (err instanceof HttpException) return err;
  return new HttpException((err as Error).message, 500);
}
