import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { PhotoService } from './photo.service.js';

const make = () => new PhotoService({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-foto-')) } as unknown as AppConfig);

describe('PhotoService', () => {
  it('guarda e devolve a foto com o tipo certo', () => {
    const svc = make();
    const id = svc.save(Buffer.from('jpeg de mentira'), 'image/jpeg');
    expect(svc.get(id)).toEqual({ data: Buffer.from('jpeg de mentira'), mime: 'image/jpeg' });
  });

  it('só aceita JPEG, PNG e WebP', () => {
    const svc = make();
    expect(svc.accepts('image/jpeg')).toBe(true);
    expect(svc.accepts('image/webp')).toBe(true);
    expect(svc.accepts('image/svg+xml')).toBe(false);
    expect(svc.accepts('text/html')).toBe(false);
  });

  it('id que não é UUID não vira caminho de arquivo', () => {
    const svc = make();
    expect(svc.get('../../.env')).toBeNull();
    expect(svc.get('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
