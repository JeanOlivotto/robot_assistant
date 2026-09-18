import { Module } from '@nestjs/common';
import { AlertService } from './alerts/alert.service.js';
import { BrainService } from './brain/brain.service.js';
import { CalendarService } from './calendar/calendar.service.js';
import { ClaudeUsageAlertService } from './claude/claude-usage-alert.service.js';
import { ClaudeUsageController } from './claude/claude-usage.controller.js';
import { ClaudeUsageService } from './claude/claude-usage.service.js';
import { AppAuthController } from './chat/app-auth.controller.js';
import { AppGateway } from './chat/app.gateway.js';
import { VoiceController } from './chat/voice.controller.js';
import { ChatService } from './chat/chat.service.js';
import { ChatStore } from './chat/chat.store.js';
import { APP_CONFIG, loadConfig } from './config/app-config.js';
import { DebugController } from './debug/debug.controller.js';
import { TokenGuard } from './debug/token.guard.js';
import { AppTokenGuard } from './auth/app-token.guard.js';
import { DeviceGateway } from './device/device.gateway.js';
import { LlmService } from './llm/llm.service.js';
import { ProactiveService } from './proactive/proactive.service.js';
import { PushController } from './push/push.controller.js';
import { PushService } from './push/push.service.js';
import { RobotStateService } from './robot/robot-state.service.js';
import { SttService } from './stt/stt.service.js';
import { TtsController } from './tts/tts.controller.js';
import { TtsService } from './tts/tts.service.js';
import { WsRouter } from './ws/ws-router.service.js';

@Module({
  controllers: [DebugController, AppAuthController, VoiceController, PushController, TtsController, ClaudeUsageController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    WsRouter,
    CalendarService,
    AlertService,
    LlmService,
    SttService,
    TtsService,
    BrainService,
    ChatStore,
    ChatService,
    RobotStateService,
    DeviceGateway,
    AppGateway,
    ProactiveService,
    PushService,
    ClaudeUsageService,
    ClaudeUsageAlertService,
    TokenGuard,
    AppTokenGuard,
  ],
})
export class AppModule {}
