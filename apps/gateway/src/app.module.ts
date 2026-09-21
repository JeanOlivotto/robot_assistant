import { Module } from '@nestjs/common';
import { AlertService } from './alerts/alert.service.js';
import { BrainService } from './brain/brain.service.js';
import { CalendarController } from './calendar/calendar.controller.js';
import { CalendarService } from './calendar/calendar.service.js';
import { ClaudeUsageAlertService } from './claude/claude-usage-alert.service.js';
import { ClaudeUsageController } from './claude/claude-usage.controller.js';
import { ClaudeUsageService } from './claude/claude-usage.service.js';
import { AppAuthController } from './chat/app-auth.controller.js';
import { AppGateway } from './chat/app.gateway.js';
import { VoiceController } from './chat/voice.controller.js';
import { VoiceSessionService } from './chat/voice-session.service.js';
import { ChatService } from './chat/chat.service.js';
import { ChatStore } from './chat/chat.store.js';
import { APP_CONFIG, loadConfig } from './config/app-config.js';
import { DebugController } from './debug/debug.controller.js';
import { TokenGuard } from './debug/token.guard.js';
import { AppTokenGuard } from './auth/app-token.guard.js';
import { DeviceGateway } from './device/device.gateway.js';
import { FirmwareController } from './firmware/firmware.controller.js';
import { FirmwareService } from './firmware/firmware.service.js';
import { LlmService } from './llm/llm.service.js';
import { InviteService } from './meeting/invite.service.js';
import { MeetingAccessGuard } from './meeting/meeting-access.guard.js';
import { MeetingController } from './meeting/meeting.controller.js';
import { MeetingService } from './meeting/meeting.service.js';
import { MemoryController } from './memory/memory.controller.js';
import { MemoryService } from './memory/memory.service.js';
import { SpotifyController } from './spotify/spotify.controller.js';
import { SpotifyService } from './spotify/spotify.service.js';
import { ProactiveService } from './proactive/proactive.service.js';
import { PushController } from './push/push.controller.js';
import { PushService } from './push/push.service.js';
import { RobotStateService } from './robot/robot-state.service.js';
import { TaskController } from './tasks/task.controller.js';
import { TaskService } from './tasks/task.service.js';
import { SttService } from './stt/stt.service.js';
import { TtsController } from './tts/tts.controller.js';
import { TtsService } from './tts/tts.service.js';
import { WsRouter } from './ws/ws-router.service.js';

@Module({
  controllers: [DebugController, AppAuthController, VoiceController, PushController, TtsController, ClaudeUsageController, MeetingController, SpotifyController, FirmwareController, MemoryController, CalendarController, TaskController],
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
    VoiceSessionService,
    RobotStateService,
    DeviceGateway,
    AppGateway,
    ProactiveService,
    PushService,
    ClaudeUsageService,
    ClaudeUsageAlertService,
    MeetingService,
    InviteService,
    MeetingAccessGuard,
    MemoryService,
    TaskService,
    SpotifyService,
    FirmwareService,
    TokenGuard,
    AppTokenGuard,
  ],
})
export class AppModule {}
