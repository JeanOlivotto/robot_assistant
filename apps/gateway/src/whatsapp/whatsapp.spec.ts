import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import type { SttService } from '../stt/stt.service.js';
import type { TtsService } from '../tts/tts.service.js';
import type { VisionService } from '../vision/vision.service.js';
import { WhatsappService } from './whatsapp.service.js';

type Interno = {
  aoReceber(raw: unknown): Promise<void>;
  gravarRecebidas(): void;
  recebidas: { m: { id: string; texto: string }; raw: { message: { audioMessage?: { mediaKey?: Uint8Array } } } }[];
};

const make = (dir: string) =>
  new WhatsappService({ DATA_DIR: dir, TZ_NAME: 'America/Sao_Paulo' } as unknown as AppConfig, {} as SttService, {} as VisionService, {} as TtsService);

const audio = (id: string) => ({
  key: { remoteJid: '5511999990001@s.whatsapp.net', id, fromMe: false },
  pushName: 'Wanderson kleber',
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: { audioMessage: { seconds: 19, mediaKey: new Uint8Array([1, 2, 3]) } },
});

describe('WhatsappService: mensagens recentes', () => {
  it('sobrevivem a um restart (deploy), com os bytes da mídia', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'robo-wa-'));
    const antes = make(dir) as unknown as Interno;
    await antes.aoReceber(audio('A1'));
    antes.gravarRecebidas();

    const depois = make(dir) as unknown as Interno;
    expect(depois.recebidas.map((r) => r.m.id)).toEqual(['A1']);
    expect([...depois.recebidas[0]!.raw.message.audioMessage!.mediaKey!]).toEqual([1, 2, 3]);
  });

  it('a mesma mensagem entregue de novo depois de uma queda não duplica', async () => {
    const svc = make(mkdtempSync(join(tmpdir(), 'robo-wa-'))) as unknown as Interno;
    await svc.aoReceber(audio('A1'));
    await svc.aoReceber(audio('A1'));
    expect(svc.recebidas).toHaveLength(1);
  });

  it('privacidade apaga da memória e do disco', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'robo-wa-'));
    const svc = make(dir);
    const int = svc as unknown as Interno;
    await int.aoReceber(audio('A1'));
    int.gravarRecebidas();
    expect(existsSync(join(dir, 'whatsapp-recebidas.json'))).toBe(true);

    svc.definirPrivacidade(true);
    expect(int.recebidas).toEqual([]);
    expect(existsSync(join(dir, 'whatsapp-recebidas.json'))).toBe(false);
    expect((make(dir) as unknown as Interno).recebidas).toEqual([]);
  });
});
