import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import { LIMITS } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';

/** Cabeçalho do binário do ESP32: 0xE9, e o esp_app_desc_t logo depois (offset 0x20). */
const IMAGE_MAGIC = 0xe9;
const DESC_OFFSET = 0x20;
const DESC_MAGIC = 0xabcd5432;
const DESC_VERSION_AT = DESC_OFFSET + 16;
const DESC_PROJECT_AT = DESC_OFFSET + 48;
const NAME_MAX = 32;

/** Tamanho da partição ota_0/ota_1 em partitions.csv — não adianta publicar algo maior. */
const MAX_IMAGE_BYTES = 0x300000;
/** Quantos binários antigos ficam guardados (para voltar atrás na mão, se precisar). */
const KEEP = 3;

export class FirmwareError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface FirmwareInfo {
  version: string;
  project: string;
  size: number;
  sha256: string;
  publishedAt: number;
  file: string;
}

/**
 * O firmware que o robô deve estar rodando. O binário é publicado por
 * `tools/publish-firmware.mjs` (POST /api/firmware) e o robô o baixa sozinho pelo Wi-Fi —
 * a versão sai do próprio binário, então não dá para publicar um arquivo que não seja firmware.
 */
@Injectable()
export class FirmwareService implements OnModuleInit {
  private readonly log = new Logger(FirmwareService.name);
  private readonly dir: string;
  private current: FirmwareInfo | null = null;

  /** Versão nova publicada agora — quem já está conectado recebe a oferta na hora. */
  readonly published$ = new Subject<FirmwareInfo>();

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.dir = rootPath(`${cfg.DATA_DIR}/firmware`);
  }

  onModuleInit(): void {
    try {
      const saved = JSON.parse(readFileSync(this.manifest, 'utf8')) as FirmwareInfo;
      statSync(join(this.dir, saved.file)); // sem o .bin, o manifesto não vale nada
      this.current = saved;
      this.log.log(`Firmware publicado: ${saved.version} (${(saved.size / 1024).toFixed(0)} kB)`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`Manifesto ignorado: ${(err as Error).message}`);
      else this.log.log('Nenhum firmware publicado ainda');
    }
  }

  latest(): FirmwareInfo | null {
    return this.current;
  }

  /** Bytes do firmware atual, para o robô baixar. */
  binary(): Buffer {
    if (!this.current) throw new FirmwareError('nenhum firmware publicado', 404);
    try {
      return readFileSync(join(this.dir, this.current.file));
    } catch {
      throw new FirmwareError('o arquivo do firmware sumiu do servidor', 410);
    }
  }

  /** Link que vai na mensagem `ota`. Leva uma chave própria: o DEVICE_TOKEN não anda em URL. */
  downloadUrl(): string {
    const url = `${this.cfg.PUBLIC_URL.replace(/\/+$/, '')}/api/device/firmware.bin?k=${this.downloadKey()}`;
    if (Buffer.byteLength(url) > LIMITS.OTA_URL_MAX_BYTES) {
      this.log.error(`PUBLIC_URL longo demais: a URL do firmware passou de ${LIMITS.OTA_URL_MAX_BYTES} bytes`);
    }
    return url;
  }

  /** Confere a chave da URL de download em tempo constante. */
  keyMatches(given: string | undefined): boolean {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.downloadKey());
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Recebe um .bin recém-compilado, confere que é firmware de verdade e passa a servi-lo. */
  publish(bin: Buffer): FirmwareInfo {
    const { version, project } = describe(bin);
    if (bin.length > MAX_IMAGE_BYTES) {
      throw new FirmwareError(`firmware de ${bin.length} bytes não cabe na partição (${MAX_IMAGE_BYTES})`, 413);
    }
    if (Buffer.byteLength(version) > LIMITS.OTA_VERSION_MAX_BYTES) {
      throw new FirmwareError(`versão "${version}" passa de ${LIMITS.OTA_VERSION_MAX_BYTES} bytes`, 400);
    }

    const sha256 = createHash('sha256').update(bin).digest('hex');
    const info: FirmwareInfo = {
      version,
      project,
      size: bin.length,
      sha256,
      publishedAt: Date.now(),
      file: `${project || 'robo'}-${version}-${sha256.slice(0, 8)}.bin`,
    };

    mkdirSync(this.dir, { recursive: true });
    const target = join(this.dir, info.file);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, bin);
    renameSync(tmp, target);
    writeFileSync(this.manifest, JSON.stringify(info, null, 2));

    const previous = this.current;
    this.current = info;
    this.prune();
    this.log.log(`Firmware ${version} publicado (${(bin.length / 1024).toFixed(0)} kB, sha ${sha256.slice(0, 12)})`);
    if (previous?.version !== version) this.published$.next(info);
    return info;
  }

  private downloadKey(): string {
    return createHash('sha256').update(`${this.cfg.DEVICE_TOKEN}|firmware`).digest('hex').slice(0, 32);
  }

  private get manifest(): string {
    return join(this.dir, 'latest.json');
  }

  private prune(): void {
    try {
      const bins = readdirSync(this.dir)
        .filter((f) => f.endsWith('.bin'))
        .map((f) => ({ f, t: statSync(join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of bins.slice(KEEP)) unlinkSync(join(this.dir, f));
    } catch (err) {
      this.log.warn(`Limpeza dos firmwares antigos: ${(err as Error).message}`);
    }
  }
}

/** Lê a versão e o nome do projeto de dentro do próprio binário (esp_app_desc_t). */
function describe(bin: Buffer): { version: string; project: string } {
  if (bin.length < DESC_OFFSET + 256 || bin[0] !== IMAGE_MAGIC) {
    throw new FirmwareError('isso não é um binário do ESP32 (falta o magic 0xE9)', 400);
  }
  if (bin.readUInt32LE(DESC_OFFSET) !== DESC_MAGIC) {
    throw new FirmwareError('binário sem esp_app_desc — mande o app .bin, não o bootloader nem a tabela de partições', 400);
  }
  const text = (at: number): string => {
    const raw = bin.subarray(at, at + NAME_MAX);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? NAME_MAX : end).toString('utf8').trim();
  };
  const version = text(DESC_VERSION_AT);
  if (!version) throw new FirmwareError('o binário não tem versão (defina PROJECT_VER no CMakeLists.txt)', 400);
  return { version, project: text(DESC_PROJECT_AT) };
}
