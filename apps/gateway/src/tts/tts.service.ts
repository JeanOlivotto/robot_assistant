import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

const MAX_CHARS = 600;
/** Frases repetidas ("Beleza, não marquei.") saem do cache, sem esperar nem gastar cota. */
const CACHE_MAX_FILES = 300;
const TIMEOUT_MS = 20_000;

export type TtsProvider = 'edge' | 'elevenlabs';

export class TtsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Texto → fala (mp3). Padrão: edge-tts (vozes neurais da Microsoft, grátis e sem chave, mas não
 * oficial — pode quebrar sem aviso). Alternativa: ElevenLabs com chave. Sem nenhum, o app usa a
 * voz do próprio aparelho.
 */
@Injectable()
export class TtsService {
  private readonly log = new Logger(TtsService.name);
  private readonly cacheDir: string;
  private edgeMissing = false;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.cacheDir = rootPath(`${cfg.DATA_DIR}/tts`);
    const p = this.provider;
    this.log.log(p ? `Voz: ${p} (${this.voice})` : 'Voz no servidor desligada — o app usa a voz do aparelho');
  }

  get provider(): TtsProvider | null {
    const c = this.cfg;
    if (c.TTS_PROVIDER === 'elevenlabs') return c.ELEVENLABS_API_KEY && c.ELEVENLABS_VOICE_ID ? 'elevenlabs' : null;
    if (c.TTS_PROVIDER === 'edge') return this.edgeMissing ? null : 'edge';
    return null;
  }

  private get voice(): string {
    return this.provider === 'elevenlabs' ? this.cfg.ELEVENLABS_VOICE_ID : this.cfg.EDGE_TTS_VOICE;
  }

  async synth(raw: string): Promise<Buffer> {
    const provider = this.provider;
    if (!provider) throw new TtsError('voz do servidor desligada', 503);
    const text = raw
      .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_CHARS);
    if (!text) throw new TtsError('texto vazio', 400);

    const key = createHash('sha1').update(`${provider}|${this.voice}|${this.cfg.EDGE_TTS_RATE}|${text}`).digest('hex');
    const file = join(this.cacheDir, `${key}.mp3`);
    try {
      return readFileSync(file);
    } catch {
      /* não está no cache */
    }

    const started = Date.now();
    const audio = provider === 'edge' ? await this.edge(text) : await this.elevenlabs(text);
    this.log.debug(`Fala gerada (${provider}) em ${Date.now() - started} ms`);
    this.store(file, audio);
    return audio;
  }

  /** edge-tts (CLI em Python): escreve o mp3 num arquivo temporário. */
  private async edge(text: string): Promise<Buffer> {
    const out = join(tmpdir(), `robo-tts-${randomUUID()}.mp3`);
    const args = ['--voice', this.cfg.EDGE_TTS_VOICE, `--rate=${this.cfg.EDGE_TTS_RATE}`, '--text', text, '--write-media', out];
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(this.cfg.EDGE_TTS_BIN, args);
        const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
        let stderr = '';
        proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        proc.on('error', (err: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          if (err.code === 'ENOENT') {
            this.edgeMissing = true;
            this.log.error(`edge-tts não encontrado (${this.cfg.EDGE_TTS_BIN}) — voz do servidor desligada`);
          }
          reject(new TtsError('voz do servidor indisponível', 503));
        });
        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) return resolve();
          this.log.warn(`edge-tts saiu com ${code}: ${stderr.trim().split('\n').pop()?.slice(0, 200)}`);
          reject(new TtsError('o serviço de voz não respondeu', 502));
        });
      });
      return await readFile(out);
    } finally {
      await rm(out, { force: true });
    }
  }

  private async elevenlabs(text: string): Promise<Buffer> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.cfg.ELEVENLABS_VOICE_ID)}?output_format=mp3_44100_64`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': this.cfg.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: this.cfg.ELEVENLABS_MODEL,
        language_code: 'pt',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Cota do mês esgotada (ou chave inválida): o app cai para a voz do aparelho.
      if (/quota_exceeded/i.test(detail)) throw new TtsError('a cota de voz do mês acabou', 503);
      this.log.warn(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
      throw new TtsError(`voz indisponível (${res.status})`, 502);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private store(file: string, audio: Buffer): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(file, audio);
      const files = readdirSync(this.cacheDir);
      if (files.length > CACHE_MAX_FILES) {
        const oldest = files
          .map((f) => ({ f, t: statSync(join(this.cacheDir, f)).mtimeMs }))
          .sort((a, b) => a.t - b.t)
          .slice(0, files.length - CACHE_MAX_FILES);
        for (const { f } of oldest) unlinkSync(join(this.cacheDir, f));
      }
    } catch (err) {
      this.log.warn(`Cache de voz: ${(err as Error).message}`);
    }
  }
}
