import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { InviteService } from './invite.service.js';
import { MeetingAccessGuard, type GuestRequest } from './meeting-access.guard.js';
import { MeetingError, MeetingService, type Meeting } from './meeting.service.js';

const StartBody = z.object({ titulo: z.string().max(120).optional() });
const InviteBody = z.object({ titulo: z.string().max(120).default('') });

/** Uma reunião sem a transcrição inteira, para as listagens não ficarem pesadas. */
function slim(m: Meeting) {
  const { transcript, ...rest } = m;
  return { ...rest, chars: transcript.length };
}

@Controller('api/meeting')
export class MeetingController {
  constructor(
    private readonly meetings: MeetingService,
    private readonly invites: InviteService,
  ) {}

  /** Cria o link para outra pessoa gravar uma reunião no seu lugar. Só o dono cria. */
  @Post('invite')
  @UseGuards(AppTokenGuard)
  @HttpCode(200)
  invite(@Body() body: unknown) {
    const parsed = InviteBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    return this.invites.create(parsed.data.titulo);
  }

  /** Os convites em pé (sem os tokens). */
  @Get('invites')
  @UseGuards(AppTokenGuard)
  listInvites() {
    return this.invites.list();
  }

  @Get('status')
  @UseGuards(MeetingAccessGuard)
  status() {
    return { ready: this.meetings.ready };
  }

  @Post('start')
  @UseGuards(MeetingAccessGuard)
  @HttpCode(200)
  start(@Body() body: unknown, @Req() req: GuestRequest) {
    if (!this.meetings.ready) throw new ServiceUnavailableException('modo reunião indisponível (falta STT ou LLM)');
    const parsed = StartBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    const convite = req.guestToken ? this.invites.check(req.guestToken) : null;
    // Quem gravou por convite entra no título, para você saber de onde veio a ata.
    const titulo = parsed.data.titulo || convite?.titulo || undefined;
    const m = this.meetings.start(titulo);
    if (req.guestToken) this.invites.note(req.guestToken, m.id);
    return slim(m);
  }

  @Post(':id/segment')
  @UseGuards(MeetingAccessGuard)
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
  @UseGuards(MeetingAccessGuard)
  @HttpCode(200)
  async stop(@Param('id') id: string, @Req() req: GuestRequest) {
    try {
      const m = await this.meetings.stop(id);
      // O convidado grava, você lê: a ata dele não volta pela resposta.
      if (req.guestToken) return { id: m.id, titulo: m.titulo, entregue: true };
      return m;
    } catch (err) {
      throw toHttp(err);
    }
  }

  @Get('list')
  @UseGuards(AppTokenGuard)
  list() {
    return this.meetings.list().map(slim);
  }

  @Delete(':id')
  @UseGuards(AppTokenGuard)
  @HttpCode(200)
  remove(@Param('id') id: string) {
    if (!this.meetings.remove(id)) throw new HttpException('reunião não encontrada', 404);
    return { ok: true };
  }

  @Get(':id')
  @UseGuards(AppTokenGuard)
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
