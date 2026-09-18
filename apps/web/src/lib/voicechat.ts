/** Modo conversa: escuta o dono (para sozinho quando ele silencia) e conversa com o servidor. */

const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

/* Limiares de detecção de voz (0..1). Ambientes barulhentos podem precisar de ajuste. */
const START_LEVEL = 0.14; // acima disso = começou a falar
const STOP_LEVEL = 0.07; // abaixo disso por um tempo = parou
const SILENCE_MS = 1300; // silêncio que encerra a fala
const NO_SPEECH_MS = 9000; // ninguém falou: desiste desta rodada
const MAX_MS = 30_000; // trava de segurança

export type ListenState = 'waiting' | 'speaking';

export interface ConverseReply {
  you: string;
  reply: string;
  face: string;
}

export async function converse(token: string, blob: Blob): Promise<ConverseReply> {
  const res = await fetch('/api/voice/converse', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
  return (await res.json()) as ConverseReply;
}

/**
 * Grava até o dono parar de falar. Devolve o áudio, ou null se ninguém falou.
 * `onLevel` alimenta o medidor; `onState` diz se está esperando voz ou já ouvindo fala.
 */
export class Listener {
  static get supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples = new Uint8Array(256);
  private raf = 0;
  private aborted = false;
  private manual = false;

  async listen(onLevel: (v: number) => void, onState: (s: ListenState) => void): Promise<Blob | null> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);

    const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start();

    const t0 = Date.now();
    let speaking = false;
    let silenceSince = 0;

    return new Promise<Blob | null>((resolve) => {
      const finish = (keep: boolean) => {
        cancelAnimationFrame(this.raf);
        const done = () => {
          const blob = keep && chunks.length ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null;
          this.release();
          resolve(blob);
        };
        if (rec.state !== 'inactive') {
          rec.onstop = done;
          rec.stop();
        } else done();
      };

      const loop = () => {
        if (this.aborted) return finish(false);
        if (this.manual) return finish(chunks.length > 0);
        const level = this.level();
        onLevel(level);
        const now = Date.now();

        if (!speaking) {
          if (level >= START_LEVEL) {
            speaking = true;
            onState('speaking');
          } else if (now - t0 > NO_SPEECH_MS) {
            return finish(false); // ninguém falou
          }
        } else if (level < STOP_LEVEL) {
          if (!silenceSince) silenceSince = now;
          else if (now - silenceSince > SILENCE_MS) return finish(true); // parou de falar
        } else {
          silenceSince = 0;
        }

        if (now - t0 > MAX_MS) return finish(speaking);
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    });
  }

  private level(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.samples);
    let peak = 0;
    for (const v of this.samples) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 64);
  }

  /** Interrompe a escuta atual e descarta (ex.: fechar o modo conversa). */
  abort(): void {
    this.aborted = true;
  }

  /** Encerra a escuta agora e envia o que já foi falado (botão "enviar"). */
  submit(): void {
    this.manual = true;
  }

  private release(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
  }
}
