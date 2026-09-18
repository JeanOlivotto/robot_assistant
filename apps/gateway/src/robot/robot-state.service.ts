import { Injectable } from '@nestjs/common';
import { BehaviorSubject, Subject } from 'rxjs';
import { LIMITS, type Face, type RobotView } from '@robo/protocol';
import { deviceText } from '../calendar/device-text.js';
import { ChatService } from '../chat/chat.service.js';

/** O que o webapp mostra do robô: se está ligado, a cara atual da tela e o estado da conversa. */
@Injectable()
export class RobotStateService {
  private connected = false;
  private face: Face | null = null;

  readonly view$ = new BehaviorSubject<RobotView>({ online: false, face: null, thinking: false, waiting_since: 0 });
  /** Frases para o balão na tela do robô (não vão para o chat). */
  readonly say$ = new Subject<{ text: string; ms: number }>();

  constructor(private readonly chat: ChatService) {
    chat.state$.subscribe(() => this.emit());
  }

  get online(): boolean {
    return this.connected;
  }

  say(text: string, ms = 6000): void {
    const clean = deviceText(text, LIMITS.SAY_MAX_BYTES);
    if (clean) this.say$.next({ text: clean, ms });
  }

  setOnline(online: boolean): void {
    this.connected = online;
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
      online: this.connected,
      face: this.connected ? this.face : null,
      thinking: s.thinking,
      waiting_since: s.waitingSince,
    });
  }
}
