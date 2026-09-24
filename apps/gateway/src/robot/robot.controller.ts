import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { ChatService } from '../chat/chat.service.js';
import { RobotStateService } from './robot-state.service.js';

@Controller('api/robot')
@UseGuards(AppTokenGuard)
export class RobotController {
  constructor(
    private readonly robot: RobotStateService,
    private readonly chat: ChatService,
  ) {}

  /** Tocou no robozinho do app: o da mesa acorda e dá um oi (o firmware acorda com react/say). */
  @Post('acordar')
  @HttpCode(200)
  acordar(): { online: boolean } {
    this.chat.acordar('happy', 2500);
    this.robot.say('oi!', 2500);
    return { online: this.robot.online };
  }
}
