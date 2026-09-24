import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

const KEEP_DAYS = 90;
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** As fotos do chat, em disco. O app já manda reduzida (~1280 px), então cada uma tem uns 200 KB. */
@Injectable()
export class PhotoService {
  private readonly log = new Logger(PhotoService.name);
  private readonly dir: string;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.dir = rootPath(`${cfg.DATA_DIR}/fotos`);
  }

  accepts(mime: string): boolean {
    return mime in TYPES;
  }

  save(image: Buffer, mime: string): string {
    const id = randomUUID();
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${id}.${TYPES[mime]}`), image);
    this.prune();
    return id;
  }

  /** A foto e o tipo dela, ou null se não existe (ou o id não é um dos nossos). */
  get(id: string): { data: Buffer; mime: string } | null {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    for (const [mime, ext] of Object.entries(TYPES)) {
      try {
        return { data: readFileSync(join(this.dir, `${id}.${ext}`)), mime };
      } catch {
        /* tenta a próxima extensão */
      }
    }
    return null;
  }

  /** Foto com mais de KEEP_DAYS vai embora; a descrição continua na conversa. */
  private prune(): void {
    const corte = Date.now() - KEEP_DAYS * 24 * 3600_000;
    try {
      for (const f of readdirSync(this.dir)) {
        const p = join(this.dir, f);
        if (statSync(p).mtimeMs < corte) rmSync(p);
      }
    } catch (err) {
      this.log.warn(`Falha ao limpar fotos antigas: ${(err as Error).message}`);
    }
  }
}
