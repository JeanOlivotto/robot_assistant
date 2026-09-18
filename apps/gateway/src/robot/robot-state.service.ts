import { Injectable } from '@nestjs/common';
import { BehaviorSubject } from 'rxjs';
import type { Face, RobotView } from '@robo/protocol';
import { ChatService } from '../chat/chat.service.js';

/** O que o webapp mostra do robô: se está ligado, a cara atual da tela e o estado da conversa. */
@Injectable()
export class RobotStateService {
  private online = false;
  private face: Face | null = null;

  readonly view$ = new BehaviorSubject<RobotView>({ online: false, face: null, thinking: false, waiting_since: 0 });

  constructor(private readonly chat: ChatService) {
    chat.state$.subscribe(() => this.emit());
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (!online) this.face = null;
    this.emit();
  }

  setFace(face: Face): void {
    this.face = face;
    this.emit();
  }

  private emit(): void {
    const s = this.chat.state;
    this.view$.next({
      online: this.online,
      face: this.online ? this.face : null,
      thinking: s.thinking,
      waiting_since: s.waitingSince,
    });
  }
}
