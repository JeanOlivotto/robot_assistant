import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import type { SttService } from '../stt/stt.service.js';
import type { TtsService } from '../tts/tts.service.js';
import type { VisionService } from '../vision/vision.service.js';
import type { Recebida } from './mensagem.js';
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

describe('WhatsappService: responder no lugar do dono', () => {
  const doZe = { id: 'X', chat: '111@lid', alt: '5511988884321@s.whatsapp.net', grupo: false } as Recebida;
  const daCarla = { id: 'Y', chat: '222@lid', alt: '5511977770000@s.whatsapp.net', grupo: false } as Recebida;
  const conectado = () => {
    const dir = mkdtempSync(join(tmpdir(), 'robo-wa-'));
    const svc = make(dir);
    (svc as unknown as { estado: string }).estado = 'conectado';
    return { svc, dir };
  };

  it('só os contatos escolhidos (pelo número, mesmo a conversa vindo pelo LID), e sobrevive a um restart', () => {
    const { svc, dir } = conectado();
    expect(svc.cobrir({ contatos: ['11 98888-4321'], horas: 2 })).toMatch(/^ok: respondendo no lugar dele/);
    expect(svc.cobrindo(doZe)).toBe(true);
    expect(svc.cobrindo(daCarla)).toBe(false);
    expect(svc.cobrindo({ ...doZe, grupo: true })).toBe(false);
    expect(make(dir).cobrindo(doZe)).toBe(true);
    svc.pararDeCobrir();
    expect(svc.cobrindo(doZe)).toBe(false);
  });

  it('sem contato nenhum (nem "todos") é erro; "todos" pega todo mundo no privado', () => {
    const { svc } = conectado();
    expect(svc.cobrir({ contatos: [] })).toMatch(/^erro/);
    svc.cobrir({ todos: true });
    expect(svc.cobrindo(daCarla)).toBe(true);
  });

  it('"todo mundo menos a Duda": ela fica de fora', () => {
    const { svc } = conectado();
    expect(svc.cobrir({ todos: true, exceto: ['11 97777-0000'] })).toContain('menos');
    expect(svc.cobrindo(doZe)).toBe(true);
    expect(svc.cobrindo(daCarla)).toBe(false);
  });

  it('grupos: só o que marca ou responde o dono, e só se ele quiser; o recado fica guardado', () => {
    const { svc } = conectado();
    const grupo = { id: 'G', chat: '999@g.us', grupo: true } as Recebida;
    svc.cobrir({ todos: true, recado: 'tô em reunião, volto às 4' });
    expect(svc.cobrindo({ ...grupo, paraDono: true })).toBe(false);
    expect(svc.recadoDoDono).toBe('tô em reunião, volto às 4');
    expect(svc.cobrir({ todos: true, grupos: true })).toContain('nos grupos');
    expect(svc.cobrindo({ ...grupo, paraDono: true })).toBe(true);
    expect(svc.cobrindo(grupo)).toBe(false);
  });

  it('agendado ("do dia 19 ao 23"): só vale dentro do período', () => {
    const { svc } = conectado();
    const dia = 24 * 3600_000;
    expect(svc.cobrir({ todos: true, de: Date.now() + dia, ate: Date.now() + 5 * dia })).toMatch(/^ok: agendado/);
    expect(svc.cobrindo(doZe)).toBe(false);
    (svc as unknown as { c: { cobrir: { de: number } } }).c.cobrir.de = Date.now() - 1;
    expect(svc.cobrindo(doZe)).toBe(true);
    expect(svc.cobrir({ todos: true, de: Date.now() + 2 * dia, ate: Date.now() + dia })).toMatch(/^erro/);
  });

  it('acabou o tempo, para sozinho', () => {
    const { svc } = conectado();
    svc.cobrir({ contatos: ['11 98888-4321'], horas: 1 });
    (svc as unknown as { c: { cobrir: { ate: number } } }).c.cobrir.ate = Date.now() - 1;
    expect(svc.cobrindo(doZe)).toBe(false);
  });
});

describe('WhatsappService: o próprio dono chamando no grupo', () => {
  const grupo = '120363000000000001@g.us';
  const doDono = (id: string, chat: string, texto: string) => ({
    key: { remoteJid: chat, id, fromMe: true },
    pushName: 'Jean',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: texto },
  });

  it('num grupo liberado, segue para o atendente marcado como dele (e não aparece no "ler")', async () => {
    const wa = make(mkdtempSync(join(tmpdir(), 'wa-')));
    wa.definirGrupoTecnico(grupo, true);
    const chegou: Recebida[] = [];
    const escreveu: string[] = [];
    wa.chegou$.subscribe((m) => chegou.push(m));
    wa.donoEscreveu$.subscribe((c) => escreveu.push(c));
    await (wa as unknown as Interno).aoReceber(doDono('D1', grupo, 'miro ?'));
    expect(chegou).toHaveLength(1);
    expect(chegou[0]).toMatchObject({ doDono: true, grupo: true, texto: 'miro ?' });
    expect(chegou[0].paraDono).toBeUndefined();
    expect(escreveu).toEqual([]);
    (wa as unknown as { estado: string }).estado = 'conectado';
    expect(await wa.ler()).not.toContain('miro ?');
  });

  it('fora dos grupos liberados continua sendo só "o dono escreveu"', async () => {
    const wa = make(mkdtempSync(join(tmpdir(), 'wa-')));
    const chegou: Recebida[] = [];
    const escreveu: string[] = [];
    wa.chegou$.subscribe((m) => chegou.push(m));
    wa.donoEscreveu$.subscribe((c) => escreveu.push(c));
    await (wa as unknown as Interno).aoReceber(doDono('D2', grupo, 'miro ?'));
    await (wa as unknown as Interno).aoReceber(doDono('D3', '5511999990001@s.whatsapp.net', 'miro ?'));
    expect(chegou).toEqual([]);
    expect(escreveu).toEqual([grupo, '5511999990001@s.whatsapp.net']);
  });
});

describe('WhatsappService: áudio no privado num dia de grupo agitado', () => {
  const agora = Math.floor(Date.now() / 1000);
  const vitor = {
    key: { remoteJid: '5511999990002@s.whatsapp.net', id: 'V1', fromMe: false },
    pushName: 'Vitor Carneiro',
    messageTimestamp: agora - 3600,
    message: { audioMessage: { seconds: 41, mediaKey: new Uint8Array([1]) } },
  };
  const doGrupo = (i: number) => ({
    key: { remoteJid: '120363000000000009@g.us', id: `G${i}`, fromMe: false, participant: '5511900000000@s.whatsapp.net' },
    pushName: 'Fulano',
    messageTimestamp: agora - 3000 + i,
    message: { conversation: `mensagem ${i}` },
  });
  const conectar = (wa: WhatsappService) => ((wa as unknown as { estado: string }).estado = 'conectado');

  it('o áudio do Vitor continua lá depois de 100 mensagens no grupo', async () => {
    const wa = make(mkdtempSync(join(tmpdir(), 'wa-')));
    conectar(wa);
    await (wa as unknown as Interno).aoReceber(vitor);
    for (let i = 0; i < 100; i++) await (wa as unknown as Interno).aoReceber(doGrupo(i));
    const lido = await wa.ler({ de: 'Vitor' });
    expect(lido).toContain('Vitor Carneiro');
    expect(lido).toContain('[áudio de 41s, sem transcrição]');
  });

  it('saiu das recentes: o histórico ainda diz que chegou e quando', async () => {
    const wa = make(mkdtempSync(join(tmpdir(), 'wa-')));
    conectar(wa);
    await (wa as unknown as Interno).aoReceber(vitor);
    (wa as unknown as Interno).recebidas = (wa as unknown as Interno).recebidas.filter((r) => r.m.id !== 'V1');
    await (wa as unknown as Interno).aoReceber(doGrupo(0));
    const lido = await wa.ler({ de: 'Vitor Carneiro' });
    expect(lido).toContain('já saiu das mensagens recentes');
    expect(lido).toContain('Vitor Carneiro: [áudio de 41s]');
  });
});
