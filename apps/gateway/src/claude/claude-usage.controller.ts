import { BadRequestException, Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { ClaudeUsageService, UsageReport } from './claude-usage.service.js';

@Controller('api/claude-usage')
@UseGuards(AppTokenGuard)
export class ClaudeUsageController {
  constructor(private readonly usage: ClaudeUsageService) {}

  @Get()
  get() {
    return this.usage.current;
  }

  /** Chamado pela barra de status do Claude Code a cada mudança nos limites. */
  @Post()
  @HttpCode(200)
  report(@Body() body: unknown) {
    const parsed = UsageReport.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
    return this.usage.report(parsed.data);
  }
}
