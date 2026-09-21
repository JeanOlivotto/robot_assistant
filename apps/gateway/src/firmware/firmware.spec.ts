import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { FirmwareError, FirmwareService } from './firmware.service.js';

/** Um .bin de mentira com a cara de um app do ESP32: 0xE9 + esp_app_desc_t no offset 0x20. */
function fakeBin(version: string, project = 'robo', bytes = 4096): Buffer {
  const bin = Buffer.alloc(bytes);
  bin[0] = 0xe9;
  bin.writeUInt32LE(0xabcd5432, 0x20);
  bin.write(version, 0x30, 'utf8');
  bin.write(project, 0x50, 'utf8');
  bin.write('conteudo', 0x200, 'utf8');
  return bin;
}

function make(): FirmwareService {
  const cfg = {
    DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-fw-')),
    DEVICE_TOKEN: 'token-do-device-bem-longo',
    PUBLIC_URL: 'https://exemplo.test',
  } as unknown as AppConfig;
  const svc = new FirmwareService(cfg);
  svc.onModuleInit();
  return svc;
}

describe('FirmwareService', () => {
  it('tira a versão de dentro do binário e guarda o arquivo', () => {
    const svc = make();
    const bin = fakeBin('0.8.0');
    const info = svc.publish(bin);

    expect(info.version).toBe('0.8.0');
    expect(info.project).toBe('robo');
    expect(info.size).toBe(bin.length);
    expect(info.sha256).toBe(createHash('sha256').update(bin).digest('hex'));
    expect(svc.latest()?.version).toBe('0.8.0');
    expect(svc.binary().equals(bin)).toBe(true);
  });

  it('recusa arquivo que não é firmware do ESP32', () => {
    const svc = make();
    expect(() => svc.publish(Buffer.from('não sou um firmware'))).toThrow(FirmwareError);

    const semDesc = fakeBin('1.0.0');
    semDesc.writeUInt32LE(0, 0x20); // apaga o esp_app_desc
    expect(() => svc.publish(semDesc)).toThrow(/esp_app_desc/);
  });

  it('recusa binário sem versão', () => {
    const svc = make();
    expect(() => svc.publish(fakeBin(''))).toThrow(/versão/);
  });

  it('avisa só quando a versão muda de verdade', () => {
    const svc = make();
    const seen: string[] = [];
    svc.published$.subscribe((f) => seen.push(f.version));

    svc.publish(fakeBin('0.8.0'));
    svc.publish(fakeBin('0.8.0', 'robo', 8192)); // recompilou a mesma versão
    svc.publish(fakeBin('0.9.0'));

    expect(seen).toEqual(['0.8.0', '0.9.0']);
  });

  it('guarda poucos binários antigos', () => {
    const svc = make();
    for (const v of ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0']) svc.publish(fakeBin(v));
    const bins = readdirSync(svc['dir'] as string).filter((f) => f.endsWith('.bin'));
    expect(bins).toHaveLength(3);
    expect(svc.binary().length).toBeGreaterThan(0); // o atual continua lá
  });

  it('a URL de download leva uma chave própria, não o token do device', () => {
    const svc = make();
    const url = svc.downloadUrl();
    expect(url).toMatch(/^https:\/\/exemplo\.test\/api\/device\/firmware\.bin\?k=[0-9a-f]{32}$/);
    expect(url).not.toContain('token-do-device');

    const key = new URL(url).searchParams.get('k')!;
    expect(svc.keyMatches(key)).toBe(true);
    expect(svc.keyMatches('chave-errada')).toBe(false);
    expect(svc.keyMatches(undefined)).toBe(false);
  });

  it('sem nada publicado, não serve binário', () => {
    const svc = make();
    expect(svc.latest()).toBeNull();
    expect(() => svc.binary()).toThrow(/nenhum firmware/);
  });
});
