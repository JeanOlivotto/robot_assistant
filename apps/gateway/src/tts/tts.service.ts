import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

const MAX_CHARS = 600;
/** Frases repetidas ("Beleza, não marquei.") saem do cache e não gastam crédito. */
const CACHE_MAX_FILES = 300;

export class TtsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Texto → fala com a ElevenLabs (plano grátis: ~20 mil caracteres/mês no modelo Flash). */
@Injectable()
export class TtsService {
  private readonly log = new Logger(TtsService.name);
  private readonly cacheDir: string;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.cacheDir = rootPath(`${cfg.DATA_DIR}/tts`);
    if (this.enabled) this.log.log(`Voz: ElevenLabs (${cfg.ELEVENLABS_MODEL}, voz ${cfg.ELEVENLABS_VOICE_ID})`);
    else this.log.log('Voz no servidor desligada (sem ELEVENLABS_API_KEY/VOICE_ID) — o app usa a voz do aparelho');
  }

  get enabled(): boolean {
    return !!(this.cfg.ELEVENLABS_API_KEY && this.cfg.ELEVENLABS_VOICE_ID);
  }

  async synth(raw: string): Promise<Buffer> {
    if (!this.enabled) throw new TtsError('voz do servidor desligada', 503);
    const text = raw
      .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_CHARS);
    if (!text) throw new TtsError('texto vazio', 400);

    const key = createHash('sha1').update(`${this.cfg.ELEVENLABS_VOICE_ID}|${this.cfg.ELEVENLABS_MODEL}|${text}`).digest('hex');
    const file = join(this.cacheDir, `${key}.mp3`);
    try {
      return readFileSync(file);
    } catch {
      /* não está no cache */
    }

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
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Cota do mês esgotada (ou chave inválida): o app cai para a voz do aparelho.
      if (/quota_exceeded/i.test(detail)) throw new TtsError('a cota de voz do mês acabou', 503);
      this.log.warn(`ElevenLabs ${res.status}: ${detail.slice(0, 200)}`);
      throw new TtsError(`voz indisponível (${res.status})`, 502);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    this.store(file, audio);
    return audio;
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
