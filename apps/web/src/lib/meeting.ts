/** Modo reunião: grava em segmentos completos (cada um é um arquivo válido) e envia um a um. */
import { acquireMic, audioContext, micSupported, releaseMic } from './mic';

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
/** Tamanho de cada trecho enviado. Curto o bastante para dar retorno; longo para não floodar. */
const SEGMENT_MS = 25_000;

export interface AtaAcao {
  texto: string;
  responsavel?: string;
  prazo?: string;
}
export interface Ata {
  resumo: string;
  pontos?: string[];
  decisoes: string[];
  acoes: AtaAcao[];
}
/** Um trecho contínuo de uma pessoa só — a reunião completa, separada por voz. */
export interface Fala {
  pessoa: number;
  inicio: number;
  fim: number;
  texto: string;
}
export interface Meeting {
  id: string;
  titulo: string;
  startedAt: number;
  endedAt?: number;
  /** processando = a ata ainda está saindo (o robô avisa no chat quando ficar pronta). */
  status?: 'gravando' | 'processando' | 'pronta';
  segments: number;
  seconds: number;
  chars: number;
  pessoas?: number;
  ata?: Ata;
}
/** A reunião inteira, com a transcrição — só quando você pede para ver. */
export interface MeetingFull extends Meeting {
  transcript: string;
  falas?: Fala[];
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
export const getMeeting = (token: string, id: string) => api<MeetingFull>(token, `/${id}`);
export const apagarMeeting = (token: string, id: string) => api<{ ok: true }>(token, `/${id}`, { method: 'DELETE' });

/** Cria o link para outra pessoa gravar uma reunião no seu lugar (vale 12 h). */
export const convidar = (token: string, titulo: string) =>
  api<{ token: string; url: string; expiresAt: number }>(token, '/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titulo }),
  });

/** Agenda direto uma ação da ata (o dono já escolheu o dia e a hora na tela). */
export async function agendar(token: string, title: string, start: Date, minutes = 60): Promise<void> {
  const res = await fetch('/api/calendar/event', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, start: start.getTime(), minutes }),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
}

/**
 * De onde vem o áudio da reunião: o microfone da sala, ou o som da aba (reunião online —
 * você compartilha a aba do Meet/Zoom marcando "compartilhar áudio" e ele ouve todo mundo).
 * Na aba entra também o microfone de quem grava: o Meet não devolve a sua própria voz para a aba.
 */
export type FonteAudio = 'mic' | 'aba';

/** Grava a reunião em segmentos completos, entregando cada Blob pronto para envio. */
export class MeetingRecorder {
  static get supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && micSupported;
  }

  private stream: MediaStream | null = null;
  private sources: MediaStreamAudioSourceNode[] = [];
  /** Stream da aba (quando a fonte é 'aba'): é nosso, não vem do microfone compartilhado. */
  private tela: MediaStream | null = null;
  /** Pegou o microfone emprestado (mic.ts) e tem que devolver no fim. */
  private usouMic = false;
  private rec: MediaRecorder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private doneResolve: (() => void) | null = null;
  private mime?: string;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples = new Uint8Array(256);

  /**
   * @param onFimDaAba quem gravava a aba clicou em "Parar de compartilhar" na barra do Chrome —
   *   para o app encerrar a reunião em vez de seguir gravando silêncio.
   */
  constructor(
    private readonly onSegment: (blob: Blob) => void,
    private readonly onFimDaAba?: () => void,
  ) {}

  static get podeGravarAba(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  }

  async start(fonte: FonteAudio = 'mic'): Promise<void> {
    if (fonte === 'aba') {
      // O vídeo é só o preço de entrada: o Chrome não compartilha áudio de aba sem ele.
      this.tela = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      this.tela.getVideoTracks().forEach((t) => t.stop());
      const audio = this.tela.getAudioTracks();
      if (!audio.length) {
        this.tela.getTracks().forEach((t) => t.stop());
        this.tela = null;
        throw new Error('Você compartilhou a aba sem o áudio. Repita marcando "compartilhar áudio da guia".');
      }
      audio[0]!.addEventListener('ended', () => {
        if (!this.stopped) this.onFimDaAba?.();
      });
    }
    try {
      this.mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      this.ctx = await audioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;

      if (this.tela) {
        // Aba + microfone misturados num stream só: a chamada inteira, inclusive quem está gravando.
        const mix = this.ctx.createMediaStreamDestination();
        const aba = this.ctx.createMediaStreamSource(new MediaStream(this.tela.getAudioTracks()));
        aba.connect(mix);
        aba.connect(this.analyser);
        this.sources.push(aba);
        try {
          const mic = this.ctx.createMediaStreamSource(await acquireMic());
          this.usouMic = true;
          mic.connect(mix);
          mic.connect(this.analyser);
          this.sources.push(mic);
        } catch {
          /* sem permissão de microfone: grava só a chamada, que já é o principal */
        }
        this.stream = mix.stream;
      } else {
        // Microfone emprestado do app (mic.ts): não pede permissão de novo a cada reunião.
        this.stream = await acquireMic();
        this.usouMic = true;
        const mic = this.ctx.createMediaStreamSource(this.stream);
        mic.connect(this.analyser);
        this.sources.push(mic);
      }
    } catch (err) {
      this.release();
      throw err;
    }
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
    this.tela?.getTracks().forEach((t) => t.stop()); // o da aba é nosso e morre aqui
    this.tela = null;
    try {
      this.sources.forEach((n) => n.disconnect());
      this.analyser?.disconnect();
    } catch {
      /* já estava solto */
    }
    this.stream = null;
    this.sources = [];
    this.rec = null;
    this.ctx = null; // o AudioContext é do app inteiro: não se fecha aqui
    this.analyser = null;
    if (this.usouMic) releaseMic(); // o mic é emprestado: devolve
    this.usouMic = false;
    this.doneResolve?.();
    this.doneResolve = null;
  }
}
