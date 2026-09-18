/** Modo reunião: grava em segmentos completos (cada um é um arquivo válido) e envia um a um. */

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
/** Tamanho de cada trecho enviado. Curto o bastante para dar retorno; longo para não floodar. */
const SEGMENT_MS = 25_000;

export interface AtaAcao {
  texto: string;
  responsavel?: string;
}
export interface Ata {
  resumo: string;
  decisoes: string[];
  acoes: AtaAcao[];
}
export interface Meeting {
  id: string;
  titulo: string;
  startedAt: number;
  endedAt?: number;
  segments: number;
  seconds: number;
  chars: number;
  ata?: Ata;
}

async function api<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/meeting${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const meetingStatus = (token: string) => api<{ ready: boolean }>(token, '/status');
export const startMeeting = (token: string, titulo?: string) =>
  api<Meeting>(token, '/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ titulo }) });
export const sendSegment = (token: string, id: string, blob: Blob) =>
  api<{ seconds: number; chars: number }>(token, `/${id}/segment`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  });
export const stopMeeting = (token: string, id: string) => api<Meeting>(token, `/${id}/stop`, { method: 'POST' });
export const listMeetings = (token: string) => api<Meeting[]>(token, '/list');

/** Grava a reunião em segmentos completos, entregando cada Blob pronto para envio. */
export class MeetingRecorder {
  static get supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private doneResolve: (() => void) | null = null;
  private mime?: string;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples = new Uint8Array(256);

  constructor(private readonly onSegment: (blob: Blob) => void) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);
    this.cycle();
  }

  /** Um MediaRecorder por segmento: ao parar, o Blob é um arquivo completo e decodificável. */
  private cycle(): void {
    if (this.stopped || !this.stream) return;
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      if (chunks.length) this.onSegment(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      if (this.stopped) this.release();
      else this.cycle();
    };
    this.rec = rec;
    rec.start();
    this.timer = setTimeout(() => rec.state !== 'inactive' && rec.stop(), SEGMENT_MS);
  }

  /** 0..1, só para o medidor. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.samples);
    let peak = 0;
    for (const v of this.samples) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 64);
  }

  /** Fecha o segmento atual (ele ainda é entregue antes de resolver) e libera o microfone. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const done = new Promise<void>((resolve) => (this.doneResolve = resolve));
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    else this.release();
    return done;
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.stream = null;
    this.rec = null;
    this.ctx = null;
    this.analyser = null;
    this.doneResolve?.();
    this.doneResolve = null;
  }
}
