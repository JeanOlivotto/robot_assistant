import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/** "Pessoa N falou de inicio a fim" — N na ordem em que cada voz aparece na reunião. */
export interface Turno {
  inicio: number;
  fim: number;
  pessoa: number;
}

/** Uma reunião de 1 h leva uns 7 min no serviço de vozes; folga para 4 h e para a fila. */
const TIMEOUT_MS = 45 * 60_000;

/** Cliente do container de vozes (apps/vozes), que separa quem falou quando. */
@Injectable()
export class VozesService {
  private readonly log = new Logger(VozesService.name);

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    if (!cfg.VOZES_URL) this.log.log('Sem VOZES_URL — as atas saem sem separar quem falou');
  }

  get enabled(): boolean {
    return !!this.cfg.VOZES_URL;
  }

  /** Turnos de fala do áudio (PCM s16le 16 kHz mono), ou null se o serviço não respondeu. */
  async diarizar(pcm: Buffer): Promise<{ pessoas: number; turnos: Turno[] } | null> {
    if (!this.enabled) return null;
    const started = Date.now();
    try {
      const res = await fetch(`${this.cfg.VOZES_URL.replace(/\/+$/, '')}/diarizar`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(pcm),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await res.json()) as { pessoas?: number; trechos?: Turno[]; erro?: string };
      if (!res.ok || !body.trechos) throw new Error(body.erro ?? `HTTP ${res.status}`);
      this.log.log(`${(pcm.length / 32000 / 60).toFixed(1)} min de áudio → ${body.pessoas} voz(es) em ${((Date.now() - started) / 1000).toFixed(0)} s`);
      return { pessoas: body.pessoas ?? 0, turnos: body.trechos };
    } catch (err) {
      this.log.warn(`Separação de vozes falhou (${(err as Error).message}) — ata sem os nomes das vozes`);
      return null;
    }
  }
}
