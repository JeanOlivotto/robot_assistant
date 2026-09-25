/**
 * O modo chamada. O microfone abre UMA vez (mic.ts) e fica aberto a conversa inteira: some o
 * pedido de permissão a cada frase e o robô volta a escutar no instante em que para de falar.
 *
 * O áudio é capturado cru (PCM 16 kHz) em vez de MediaRecorder, o que dá três coisas:
 * um detector de voz que se adapta ao barulho da sala, um "pré-rolo" (o começo da frase que
 * você falou ANTES de o robô perceber não se perde) e o corte imediato quando você fala por cima.
 */
import { acquireMic, audioContext, micSupported, releaseMic } from './mic';
import { cabecalhosDeOnde } from './origem';

const RATE = 16000;
const PRE_ROLL_MS = 900; // quanto do passado entra junto quando o turno abre
const BARGE_PRE_ROLL_MS = 350; // ao cortar o robô, pega pouco de trás (o resto é eco dele)
const SILENCE_MS = 900; // silêncio que encerra a sua fala (700 ms atropelava as pausas; 1100 ms deixava a ligação arrastada)
const MIN_SPEECH_MS = 280; // menos que isso é tosse, estalo, porta batendo
const NO_SPEECH_MS = 8000; // ninguém falou nesta rodada: volta vazio (quem chama decide se segue ouvindo)
const MAX_MS = 30_000; // trava de segurança
/*
 * Interrupção. No iPhone o cancelamento de eco nem sempre vale para o som do <audio>: a voz do
 * próprio robô volta pelo microfone e parecia que você tinha falado por cima — ele se cortava no
 * meio da frase. Agora ele aprende o nível desse eco enquanto fala e só conta como interrupção
 * uma voz bem acima dele, sustentada por mais tempo.
 */
const BARGE_MS = 450; // voz por cima da fala do robô por este tempo = você o interrompeu
const BARGE_GRACE_MS = 500; // o comecinho da fala dele só serve para medir o eco
const BARGE_OVER_ECHO = 3.2; // quantas vezes acima do eco precisa ser

export type ListenState = 'waiting' | 'speaking';

export interface ConverseReply {
  you: string;
  reply: string;
  face: string;
  action?: 'start_meeting';
}

export interface CallStart {
  session: string;
  greeting: string;
}

/** Abre uma conversa NOVA no servidor e recebe a fala de abertura. */
export async function startCall(token: string): Promise<CallStart> {
  const res = await fetch('/api/voice/session', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
  return (await res.json()) as CallStart;
}

export async function converse(token: string, blob: Blob, session?: string): Promise<ConverseReply> {
  const url = session ? `/api/voice/converse?s=${encodeURIComponent(session)}` : '/api/voice/converse';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': blob.type || 'audio/wav', ...cabecalhosDeOnde() },
    body: blob,
  });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
  return (await res.json()) as ConverseReply;
}

/** Código do capturador que roda na thread de áudio: junta ~512 amostras e manda para cá. */
const WORKLET = `
class RoboCapture extends AudioWorkletProcessor {
  constructor() { super(); this.parts = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.parts.push(new Float32Array(ch));
      this.n += ch.length;
      if (this.n >= 512) {
        const out = new Float32Array(this.n);
        let o = 0;
        for (const p of this.parts) { out.set(p, o); o += p.length; }
        this.parts = []; this.n = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('robo-capture', RoboCapture);
`;

const loaded = new WeakMap<AudioContext, Promise<void>>();

type FrameHandler = (rms: number, ms: number) => void;

export class VoiceSession {
  static get supported(): boolean {
    return micSupported && typeof AudioContext !== 'undefined';
  }

  private src: MediaStreamAudioSourceNode | null = null;
  private node: AudioNode | null = null;
  private sink: GainNode | null = null;
  private rate = RATE;

  private pre: Float32Array[] = []; // pré-rolo: o passado recente, sempre à mão
  private preLen = 0;
  private turn: Float32Array[] | null = null; // gravação do turno em andamento
  private turnLen = 0;
  private noise = 0.006; // piso de ruído da sala, aprendido sozinho
  private frame: FrameHandler | null = null;
  private resamplePos = 0;

  private closed = false;
  private aborted = false;
  private manual = false;
  private cancelWatch: (() => void) | null = null;
  private cancelTurn: (() => void) | null = null;
  private bargeArmedAt = 0;
  private muted = false;

  /** Pede o microfone e liga a captura. Uma vez por chamada. */
  async open(): Promise<void> {
    const stream = await acquireMic();
    try {
      const ctx = await audioContext();
      this.rate = ctx.sampleRate;
      this.src = ctx.createMediaStreamSource(stream);
      this.node = await this.capture(ctx);
      // Ganho zero: o ScriptProcessor só roda se estiver ligado na saída, mas nada é reproduzido.
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.src.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(ctx.destination);
    } catch (err) {
      releaseMic(); // não segura o microfone se a montagem falhou no meio
      throw err;
    }
  }

  /** Escuta um turno. Devolve o WAV, ou null se ninguém falou. */
  listen(opts: { onLevel?: (v: number) => void; onState?: (s: ListenState) => void; preRollMs?: number } = {}): Promise<Blob | null> {
    this.aborted = false;
    this.manual = false;
    this.startTurn(opts.preRollMs ?? PRE_ROLL_MS);
    opts.onState?.('waiting');

    const t0 = Date.now();
    let speaking = false;
    let speechMs = 0;
    let silenceMs = 0;

    return new Promise<Blob | null>((resolve) => {
      const finish = (keep: boolean) => {
        this.frame = null;
        this.cancelTurn = null;
        const pcm = this.endTurn();
        opts.onLevel?.(0);
        resolve(keep && pcm.length >= (RATE * MIN_SPEECH_MS) / 1000 ? toWav(pcm) : null);
      };
      // Se a chamada fechar com o microfone mudo, nenhum quadro chega para encerrar o turno.
      this.cancelTurn = () => finish(false);

      this.frame = (rms, ms) => {
        if (this.closed || this.aborted) return finish(false);
        if (this.manual) return finish(speechMs - silenceMs >= MIN_SPEECH_MS);
        opts.onLevel?.(Math.min(1, rms * 7));

        const startAt = Math.max(0.014, this.noise * 3.2);
        const stopAt = Math.max(0.009, this.noise * 1.9);

        if (!speaking) {
          this.noise = this.noise * 0.92 + rms * 0.08; // enquanto ninguém fala, aprende a sala
          if (rms >= startAt) {
            speaking = true;
            speechMs = ms;
            opts.onState?.('speaking');
          } else if (Date.now() - t0 > NO_SPEECH_MS) return finish(false);
        } else {
          speechMs += ms;
          if (rms < stopAt) {
            silenceMs += ms;
            if (silenceMs >= SILENCE_MS) return finish(speechMs - silenceMs >= MIN_SPEECH_MS);
          } else silenceMs = 0;
        }
        if (Date.now() - t0 > MAX_MS) return finish(speaking);
      };
    });
  }

  /**
   * Fica de ouvido enquanto o robô fala. Resolve `true` quando você o interrompe —
   * aí é só parar a fala e chamar listen({ preRollMs: BARGE_PRE_ROLL }).
   */
  watchBargeIn(): Promise<boolean> {
    this.bargeArmedAt = 0; // só vale a partir de armBargeIn(), quando o som sai de verdade
    return new Promise<boolean>((resolve) => {
      let loudMs = 0;
      let echo = 0; // quanto da voz dele volta pelo microfone (aprendido enquanto ele fala)
      const stop = (v: boolean) => {
        if (this.frame) this.frame = null;
        this.cancelWatch = null;
        resolve(v);
      };
      this.cancelWatch = () => stop(false);
      this.frame = (rms, ms) => {
        if (this.closed || this.aborted) return stop(false);
        if (!this.bargeArmedAt || this.muted) return;
        if (Date.now() - this.bargeArmedAt < BARGE_GRACE_MS) {
          echo = Math.max(echo * 0.9, rms); // o começo é só eco: guarda o pico dele
          return;
        }
        const limiar = Math.max(0.06, echo * BARGE_OVER_ECHO, this.noise * 6);
        if (rms >= limiar) {
          loudMs += ms;
          if (loudMs >= BARGE_MS) return stop(true);
        } else {
          loudMs = Math.max(0, loudMs - ms);
          echo = echo * 0.98 + rms * 0.02; // o eco muda com o volume da frase: acompanha devagar
        }
      };
    });
  }

  /** Microfone mudo: nada do que for dito conta, nem para interromper. */
  setMuted(on: boolean): void {
    this.muted = on;
  }

  /** O alto-falante começou a tocar: a partir de agora (menos um respiro) vale te ouvir por cima. */
  armBargeIn(): void {
    this.bargeArmedAt = Date.now();
  }

  /**
   * O robô terminou de falar sem ser cortado: para de vigiar e joga fora o pré-rolo, que nesse
   * trecho só tem o eco da voz dele — não é para isso virar "fala do dono" no próximo turno.
   */
  stopWatching(): void {
    this.cancelWatch?.();
    this.pre = [];
    this.preLen = 0;
  }

  static get bargePreRollMs(): number {
    return BARGE_PRE_ROLL_MS;
  }

  /** Encerra a escuta agora e manda o que já foi falado (botão "Enviar"). */
  submit(): void {
    this.manual = true;
  }

  /** Larga o turno atual sem mandar nada. */
  abort(): void {
    this.aborted = true;
    this.cancelWatch?.();
    this.cancelTurn?.();
  }

  /** Fim da chamada. O microfone volta para o pote comum (não é desligado na hora). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort();
    this.frame = null;
    this.turn = null;
    this.pre = [];
    this.preLen = 0;
    if (this.node && 'port' in this.node) (this.node as AudioWorkletNode).port.onmessage = null;
    if (this.node && 'onaudioprocess' in this.node) (this.node as ScriptProcessorNode).onaudioprocess = null;
    try {
      this.src?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* já estava solto */
    }
    this.src = this.sink = null;
    this.node = null;
    releaseMic();
  }

  private async capture(ctx: AudioContext): Promise<AudioNode> {
    if (ctx.audioWorklet) {
      try {
        let ready = loaded.get(ctx);
        if (!ready) {
          const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
          ready = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
          loaded.set(ctx, ready);
        }
        await ready;
        const node = new AudioWorkletNode(ctx, 'robo-capture');
        node.port.onmessage = (e: MessageEvent<Float32Array>) => this.feed(e.data);
        return node;
      } catch {
        loaded.delete(ctx); // navegador sem worklet: usa o processador antigo
      }
    }
    const node = ctx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (e) => this.feed(new Float32Array(e.inputBuffer.getChannelData(0)));
    return node;
  }

  private feed(raw: Float32Array): void {
    if (this.closed || !raw.length) return;
    let pcm = this.to16k(raw);
    if (!pcm.length) return;
    if (this.muted) pcm = new Float32Array(pcm.length); // mudo: segue o relógio, mas em silêncio
    this.pushPre(pcm);
    if (this.turn) {
      this.turn.push(pcm);
      this.turnLen += pcm.length;
    }
    let sum = 0;
    for (const v of pcm) sum += v * v;
    this.frame?.(Math.sqrt(sum / pcm.length), (pcm.length / RATE) * 1000);
  }

  private startTurn(preRollMs: number): void {
    const keep = Math.round((RATE * preRollMs) / 1000);
    const roll: Float32Array[] = [];
    let len = 0;
    for (let i = this.pre.length - 1; i >= 0 && len < keep; i--) {
      roll.unshift(this.pre[i]!);
      len += this.pre[i]!.length;
    }
    this.turn = roll;
    this.turnLen = len;
    this.pre = [];
    this.preLen = 0;
  }

  private endTurn(): Float32Array {
    const parts = this.turn ?? [];
    const out = new Float32Array(this.turnLen);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    this.turn = null;
    this.turnLen = 0;
    this.pre = []; // o que foi falado já foi enviado
    this.preLen = 0;
    return out;
  }

  private pushPre(chunk: Float32Array): void {
    const max = Math.round((RATE * PRE_ROLL_MS) / 1000);
    this.pre.push(chunk);
    this.preLen += chunk.length;
    while (this.pre.length > 1 && this.preLen - this.pre[0]!.length >= max) {
      this.preLen -= this.pre.shift()!.length;
    }
  }

  /** A placa de som nem sempre entrega 16 kHz; aqui tudo vira 16 kHz antes de virar WAV. */
  private to16k(src: Float32Array): Float32Array {
    if (Math.abs(this.rate - RATE) < 1) return src;
    const step = this.rate / RATE;
    const out = new Float32Array(Math.ceil((src.length - this.resamplePos) / step) + 1);
    let n = 0;
    let p = this.resamplePos;
    for (; p < src.length; p += step) {
      const i = Math.floor(p);
      const a = src[i] ?? 0;
      const b = src[i + 1] ?? a;
      out[n++] = a + (b - a) * (p - i);
    }
    this.resamplePos = p - src.length;
    return out.subarray(0, n);
  }
}

/** PCM → WAV 16 kHz mono 16 bits (o formato que o servidor transcreve sem converter nada). */
function toWav(pcm: Float32Array): Blob {
  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const tag = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  tag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}
