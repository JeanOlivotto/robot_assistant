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

describe('WhatsappService: cliente fora da agenda', () => {
  const msg = (id: string, texto: string, lid: string, pn: string, pushName: string) => ({
    key: { remoteJid: lid, remoteJidAlt: pn, id, fromMe: false },
    pushName,
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: texto },
  });
  const montar = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'robo-wa-'));
    const svc = make(dir);
    (svc as unknown as { estado: string }).estado = 'conectado';
    const int = svc as unknown as Interno & { gravarHistorico(): void };
    await int.aoReceber(msg('M1', 'Oi, preciso da nota fiscal do serviço', '111@lid', '5511988884321@s.whatsapp.net', 'Zé'));
    await int.aoReceber(msg('M2', 'Bom dia! Tudo certo pra amanhã?', '222@lid', '5511977770000@s.whatsapp.net', 'Carla'));
    return { svc, int, dir };
  };

  it('acha pelo assunto e a conversa achada vira a do "responde ele"', async () => {
    const { svc } = await montar();
    const achado = svc.procurar('o cliente que falou da nota fiscal');
    expect(achado).toContain('Zé (+5511988884321)');
    expect(achado).not.toContain('Carla');
    expect(svc.resolver().destino?.id).toBe('5511988884321@s.whatsapp.net');
  });

  it('acha pelo final do número, e número inteiro novo também vale', async () => {
    const { svc } = await montar();
    expect(svc.resolver('final 4321').destino?.id).toBe('5511988884321@s.whatsapp.net');
    expect(svc.resolver('11 96666-5555').destino?.id).toBe('5511966665555@s.whatsapp.net');
  });

  it('apelido: guarda, acha por ele e sobrevive a um restart', async () => {
    const { svc, dir } = await montar();
    svc.procurar('nota fiscal');
    expect(svc.apelidar('cliente da padaria')).toContain('"cliente da padaria" é Zé');
    (svc as unknown as { gravarContatos(): void }).gravarContatos();
    const depois = make(dir);
    (depois as unknown as { estado: string }).estado = 'conectado';
    expect(depois.resolver('pro cliente da padaria').destino?.id).toBe('5511988884321@s.whatsapp.net');
  });

  it('o texto guardado sobrevive a um restart, e a privacidade apaga', async () => {
    const { svc, int, dir } = await montar();
    int.gravarHistorico();
    expect(make(dir).procurar('nota fiscal')).toContain('Zé');
    svc.definirPrivacidade(true);
    expect(existsSync(join(dir, 'whatsapp-historico.json'))).toBe(false);
    svc.definirPrivacidade(false);
    expect(make(dir).procurar('nota fiscal')).toContain('nenhuma conversa');
  });
});
