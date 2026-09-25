import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { pcmFromWav } from './wav.js';

const PROTO_DIR = fileURLToPath(new URL('../../proto', import.meta.url));
const SAMPLE_RATE = 16000;
/** O Whisper trabalha em janelas de 30 s: áudio maior vai em pedaços. */
const CHUNK_BYTES = SAMPLE_RATE * 2 * 28;
export const MAX_VOICE_SECONDS = 120;

/** Frase com horário (segundos a partir do começo do áudio). */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  text: string;
  seconds: number;
  /** Só quando o provedor devolve (Groq, verbose_json). */
  segments?: TranscriptSegment[];
}

interface RecognizeResponse {
  results: { alternatives: { transcript: string }[] }[];
}

interface RivaAsrClient extends grpc.Client {
  Recognize(
    req: object,
    meta: grpc.Metadata,
    opts: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, res?: RecognizeResponse) => void,
  ): void;
}

export class SttError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Fala → texto. Padrão: Whisper turbo da Groq (rápido, um tiro só). Opção: Riva gRPC da NVIDIA. */
@Injectable()
export class SttService {
  private readonly log = new Logger(SttService.name);
  private readonly client: RivaAsrClient | null = null;
  private readonly apiKey: string;
  private readonly groq: { url: string; key: string; model: string } | null = null;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    if (cfg.STT_PROVIDER === 'groq') {
      // Reusa a chave do LLM (Groq). STT_API_KEY costuma ser a da NVIDIA, então só entra se não houver a do LLM.
      const key = cfg.LLM_API_KEY || cfg.STT_API_KEY;
      if (!key) {
        this.log.warn('Sem chave para transcrição na Groq (LLM_API_KEY) — mensagens de voz desligadas');
      } else {
        this.groq = { url: `${cfg.LLM_BASE_URL.replace(/\/+$/, '')}/audio/transcriptions`, key, model: cfg.STT_MODEL };
        this.log.log(`Transcrição pela Groq (${cfg.STT_MODEL})`);
      }
      this.apiKey = key;
      return;
    }

    // A transcrição é da NVIDIA: a chave dela é a do STT ou, na falta, a da reserva do LLM.
    this.apiKey = cfg.STT_API_KEY || cfg.LLM_FALLBACK_API_KEY || cfg.LLM_API_KEY;
    if (!this.apiKey) {
      this.log.warn('Sem chave da NVIDIA para transcrição (STT_API_KEY) — mensagens de voz desligadas');
      return;
    }
    const def = protoLoader.loadSync('riva/proto/riva_asr.proto', {
      includeDirs: [PROTO_DIR],
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
    });
    const pkg = grpc.loadPackageDefinition(def) as unknown as {
      nvidia: { riva: { asr: { RivaSpeechRecognition: grpc.ServiceClientConstructor } } };
    };
    const Client = pkg.nvidia.riva.asr.RivaSpeechRecognition;
    this.client = new Client(cfg.STT_ENDPOINT, grpc.credentials.createSsl()) as unknown as RivaAsrClient;
  }

  get enabled(): boolean {
    return this.client !== null || this.groq !== null;
  }

  /**
   * `dica`: manda o nome do dono como vocabulário. Bom para conversa ("Jean" saía "Gia"), ruim
   * para trecho em silêncio — o Whisper devolve a própria dica ("Nomes, Jeean."). Nas reuniões,
   * cheias de silêncio, vai sem.
   */
  async transcribe(audio: Buffer, opts: { dica?: boolean } = {}): Promise<Transcript> {
    if (this.groq) return this.transcribeGroq(audio, opts.dica ?? true);
    if (!this.client) throw new SttError('transcrição desligada no servidor', 503);
    const pcm = await this.toPcm(audio);
    const seconds = pcm.length / (SAMPLE_RATE * 2);
    if (seconds < 0.3) throw new SttError('áudio vazio', 422);
    if (seconds > MAX_VOICE_SECONDS) throw new SttError(`áudio maior que ${MAX_VOICE_SECONDS} s`, 413);

    const started = Date.now();
    const parts: string[] = [];
    for (let i = 0; i < pcm.length; i += CHUNK_BYTES) parts.push(await this.recognize(pcm.subarray(i, i + CHUNK_BYTES)));
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    this.log.log(`Transcrito ${seconds.toFixed(1)} s de áudio em ${Date.now() - started} ms`);
    return { text, seconds };
  }

  private recognize(pcm: Buffer): Promise<string> {
    const meta = new grpc.Metadata();
    meta.add('function-id', this.cfg.STT_FUNCTION_ID);
    meta.add('authorization', `Bearer ${this.apiKey}`);
    const req = {
      config: {
        encoding: 'LINEAR_PCM',
        sample_rate_hertz: SAMPLE_RATE,
        language_code: this.cfg.STT_LANGUAGE,
        max_alternatives: 1,
        audio_channel_count: 1,
      },
      audio: pcm,
    };
    return new Promise((resolve, reject) => {
      this.client!.Recognize(req, meta, { deadline: Date.now() + 60_000 }, (err, res) => {
        if (err) reject(new SttError(`transcrição falhou: ${err.details || err.message}`, 502));
        else resolve((res?.results ?? []).map((r) => r.alternatives[0]?.transcript ?? '').join(' '));
      });
    });
  }

  /** Groq: converte para FLAC 16 kHz mono e manda de uma vez só (bem mais rápido que a NVIDIA). */
  private async transcribeGroq(audio: Buffer, dica: boolean): Promise<Transcript> {
    const g = this.groq!;
    const flac = await this.ffmpeg(audio, ['-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'flac']);

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(flac)], { type: 'audio/flac' }), 'audio.flac');
    form.append('model', g.model);
    form.append('language', this.cfg.STT_LANGUAGE);
    form.append('response_format', 'verbose_json');
    // Dica de vocabulário: sem ela o Whisper não conhece o nome do dono ("Jean" saía "Gia") — e é
    // esse nome que vai para o banco de vozes quando ele se apresenta. Curta de propósito: uma
    // frase inteira ("Conversa com Jean…") fazia ele escrever "Jeean"; "Nomes: Jean." não.
    // Sem dica de vocabulário: "Nomes: Jean." fazia o Whisper devolver a dica em fala curta ou
    // silêncio ("Nome. Nome. Nome.", "SOU JEEAN") — o "sim" de um lembrete se perdeu assim. O nome
    // do dono vem da confirmação ("é você, Jean?"), não da transcrição.
    if (dica && this.cfg.OWNER_NAME && process.env.STT_DICA === '1') form.append('prompt', `Nomes: ${this.cfg.OWNER_NAME}.`);

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(g.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${g.key}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new SttError(`transcrição falhou: ${(err as Error).message}`, 502);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 160);
      throw new SttError(`transcrição falhou (${res.status}): ${detail}`, res.status === 429 ? 429 : 502);
    }
    const data = (await res.json()) as { text?: string; duration?: number; segments?: { start: number; end: number; text: string }[] };
    const text = (data.text ?? '').replace(/\s+/g, ' ').trim();
    const seconds = data.duration ?? 0;
    this.log.log(`Transcrito ${seconds ? `${seconds.toFixed(1)} s de ` : ''}áudio em ${Date.now() - started} ms (Groq)`);
    // Silêncio com dica vira a própria dica ("Nomes, Jeean. Nome."): isso não é fala.
    if (!text || (dica && ecoDaDica(text))) throw new SttError('não entendi nada nesse áudio', 422);
    // Frases com horário: é o que casa a transcrição com "quem falou quando" na reunião.
    const segments = (data.segments ?? [])
      .map((s) => ({ start: s.start, end: s.end, text: s.text.replace(/\s+/g, ' ').trim() }))
      .filter((s) => s.text);
    return { text, seconds, segments };
  }

  /** Roda o ffmpeg com a saída pedida e devolve os bytes. Arquivos temporários (MP4 não faz stream). */
  private async ffmpeg(audio: Buffer, outArgs: string[]): Promise<Buffer> {
    const base = join(tmpdir(), `robo-${randomUUID()}`);
    const input = `${base}.in`;
    const output = `${base}.out`;
    await writeFile(input, audio);
    try {
      await new Promise<void>((resolve, reject) => {
        const ff = spawn(this.cfg.FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, ...outArgs, output]);
        let stderr = '';
        ff.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        ff.on('error', (err) => reject(new SttError(`ffmpeg indisponível (${err.message})`, 500)));
        ff.on('close', (code) =>
          code === 0 ? resolve() : reject(new SttError(`formato de áudio não suportado: ${stderr.trim().slice(0, 160)}`, 415)),
        );
      });
      return await readFile(output);
    } finally {
      await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
    }
  }

  /** Qualquer áudio (AAC do iPhone, Opus do Chrome, WAV) → PCM 16 kHz mono 16 bits. */
  async toPcm(audio: Buffer): Promise<Buffer> {
    const wav = pcmFromWav(audio);
    if (wav) return wav;

    // Arquivo temporário em vez de pipe: MP4 com o índice no fim não é lido de stream.
    const base = join(tmpdir(), `robo-${randomUUID()}`);
    const input = `${base}.in`;
    const output = `${base}.pcm`;
    await writeFile(input, audio);
    try {
      await new Promise<void>((resolve, reject) => {
        const ff = spawn(this.cfg.FFMPEG_PATH, [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
          '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', output,
        ]);
        let stderr = '';
        ff.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        ff.on('error', (err) => reject(new SttError(`ffmpeg indisponível (${err.message})`, 500)));
        ff.on('close', (code) =>
          code === 0 ? resolve() : reject(new SttError(`formato de áudio não suportado: ${stderr.trim().slice(0, 160)}`, 415)),
        );
      });
      return await readFile(output);
    } finally {
      await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
    }
  }
}

/** A transcrição é só o eco da dica "Nomes: Jean." (o Whisper inventando em cima do silêncio)? */
export function ecoDaDica(texto: string): boolean {
  const palavras = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!palavras.length) return false;
  // "Nome. Nome. Nome. Nome. Nome." — só a palavra da dica, repetida quantas vezes for.
  if (palavras.every((p) => p.startsWith('nome'))) return true;
  return palavras.length <= 4 && palavras[0]!.startsWith('nome');
}
