/** Grava uma mensagem de voz pelo microfone (AAC no iPhone, Opus no Chrome) e mede o volume para a tela. */

const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export const MAX_VOICE_MS = 120_000;

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples = new Uint8Array(256);

  static get supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start();

    // Medidor de volume: só visual, para você ver que o microfone está pegando.
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);
  }

  /** 0..1 */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.samples);
    let peak = 0;
    for (const v of this.samples) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 64);
  }

  stop(): Promise<Blob> {
    const rec = this.recorder;
    if (!rec) return Promise.reject(new Error('não estava gravando'));
    return new Promise((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/mp4' });
        this.release();
        resolve(blob);
      };
      rec.stop();
    });
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stream = null;
    this.recorder = null;
    this.ctx = null;
    this.analyser = null;
  }
}
