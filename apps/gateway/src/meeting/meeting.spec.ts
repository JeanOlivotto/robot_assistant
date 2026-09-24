import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import type { LlmService } from '../llm/llm.service.js';
import { SttError, type SttService } from '../stt/stt.service.js';
import { TaskService } from '../tasks/task.service.js';
import type { ChatService } from '../chat/chat.service.js';
import type { VozesService } from '../vozes/vozes.service.js';
import { MeetingService, quemFalou } from './meeting.service.js';

function make(llmReply: string, stt?: Partial<SttService>, vozes?: Partial<VozesService>) {
  const cfg = { DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-meet-')) } as unknown as AppConfig;
  const sttSvc = {
    enabled: true,
    transcribe: vi.fn().mockResolvedValue({ text: 'oi pessoal, decidimos lançar sexta', seconds: 5 }),
    // 25 s de PCM por trecho (16 kHz, 16 bits)
    toPcm: vi.fn().mockResolvedValue(Buffer.alloc(25 * 32000)),
    ...stt,
  } as unknown as SttService;
  const llm = { enabled: true, complete: vi.fn().mockResolvedValue({ content: llmReply }) } as unknown as LlmService;
  const chat = { robotSay: vi.fn() } as unknown as ChatService;
  const vozesSvc = { enabled: false, diarizar: vi.fn().mockResolvedValue(null), ...vozes } as unknown as VozesService;
  // As ações da ata viram pendências: o serviço de verdade, num diretório temporário.
  const tasks = new TaskService(cfg);
  const deps = { stt: sttSvc, llm, tasks, vozes: vozesSvc, chat };
  const novo = () => new MeetingService(cfg, sttSvc, llm, tasks, vozesSvc, chat);
  return { svc: novo(), novo, cfg, deps, tasks, chat };
}

const CLEAN = JSON.stringify({
  resumo: 'Time alinhou o lançamento.',
  decisoes: ['Lançar na sexta'],
  acoes: [{ texto: 'Preparar release', responsavel: 'Fábio' }, { texto: 'Avisar clientes' }],
});

describe('MeetingService', () => {
  it('as ações da ata viram pendências para o robô cobrar', async () => {
    const { svc, tasks } = make(CLEAN);
    const m = svc.start('Reunião');
    await svc.addSegment(m.id, Buffer.from('audio'));
    await svc.stop(m.id);

    const abertas = tasks.open();
    expect(abertas.map((t) => t.texto)).toEqual(['Preparar release', 'Avisar clientes']);
    expect(abertas[0]!.pessoa).toBe('Fábio');
    expect(abertas[0]!.origem).toBe('ata');
    expect(abertas[0]!.meetingId).toBe(m.id);
  });

  it('apagar tira a reunião da lista de vez', async () => {
    const { svc } = make(CLEAN);
    const m = svc.start('Reunião para apagar');
    await svc.addSegment(m.id, Buffer.from('audio'));
    await svc.stop(m.id);
    expect(svc.list()).toHaveLength(1);

    expect(svc.remove(m.id)).toBe(true);
    expect(svc.list()).toEqual([]);
    expect(svc.get(m.id)).toBeNull();
    expect(svc.remove(m.id)).toBe(false); // já não existe
  });

  it('fluxo completo: transcreve, gera ata e notifica', async () => {
    const { svc, chat } = make(CLEAN);
    const m = svc.start('Planejamento');
    await svc.addSegment(m.id, Buffer.from('audio'));
    const done = await svc.stop(m.id);
    expect(done.ata?.resumo).toContain('lançamento');
    expect(done.ata?.decisoes).toEqual(['Lançar na sexta']);
    expect(done.ata?.acoes[0]).toEqual({ texto: 'Preparar release', responsavel: 'Fábio' });
    expect(done.ata?.acoes[1]).toEqual({ texto: 'Avisar clientes' });
    // avisa no chat duas vezes: quando a reunião acaba e quando a ata fica pronta
    expect(chat.robotSay).toHaveBeenCalledTimes(2);
    expect((chat.robotSay as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toContain('ficou pronta');
    // persistiu: dá para reler depois
    expect(svc.get(m.id)?.ata?.decisoes.length).toBe(1);
  });

  it('aceita JSON embrulhado em cercas de código', async () => {
    const { svc } = make('```json\n' + CLEAN + '\n```');
    const m = svc.start();
    await svc.addSegment(m.id, Buffer.from('a'));
    const done = await svc.stop(m.id);
    expect(done.ata?.decisoes).toEqual(['Lançar na sexta']);
  });

  it('resposta sem JSON vira resumo, sem quebrar', async () => {
    const { svc } = make('Não consegui estruturar, mas o time decidiu lançar sexta.');
    const m = svc.start();
    await svc.addSegment(m.id, Buffer.from('a'));
    const done = await svc.stop(m.id);
    expect(done.ata?.resumo).toContain('lançar sexta');
    expect(done.ata?.decisoes).toEqual([]);
  });

  it('trecho em silêncio (SttError 422) não derruba a gravação', async () => {
    const { svc } = make(CLEAN, { transcribe: vi.fn().mockRejectedValue(new SttError('vazio', 422)) as never });
    const m = svc.start();
    await expect(svc.addSegment(m.id, Buffer.from('silencio'))).resolves.toEqual({ seconds: 0, chars: 0 });
    const done = await svc.stop(m.id);
    expect(done.ata?.resumo).toContain('não teve fala');
  });

  it('um reinício no meio da reunião não perde o que já foi transcrito', async () => {
    const { svc, novo } = make(CLEAN);
    const m = svc.start('Reunião longa');
    await svc.addSegment(m.id, Buffer.from('audio'));

    // Deploy: o serviço sobe de novo, com a memória vazia, lendo o mesmo diretório.
    const depois = novo();
    expect(depois.list()).toEqual([]); // em andamento não aparece na lista de atas
    await depois.addSegment(m.id, Buffer.from('audio'));
    const fim = await depois.stop(m.id);
    expect(fim.segments).toBe(2);
    expect(fim.ata?.decisoes).toEqual(['Lançar na sexta']);
  });

  it('encerrar duas vezes não refaz a ata nem avisa de novo', async () => {
    const { svc, deps, chat } = make(CLEAN);
    const m = svc.start('Reunião');
    await svc.addSegment(m.id, Buffer.from('audio'));
    await svc.stop(m.id);
    await svc.stop(m.id);
    expect(deps.llm.complete).toHaveBeenCalledTimes(1);
    expect(chat.robotSay).toHaveBeenCalledTimes(2);
  });

  it('se o LLM cair, a transcrição fica guardada', async () => {
    const { svc, deps } = make(CLEAN);
    (deps.llm.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('groq fora'));
    const m = svc.start('Reunião');
    await svc.addSegment(m.id, Buffer.from('audio'));
    const fim = await svc.stop(m.id);
    expect(fim.ata?.resumo).toContain('groq fora');
    expect(svc.get(m.id)?.transcript).toContain('decidimos lançar sexta');
  });

  it('com o serviço de vozes, a transcrição sai separada por pessoa e a ata recebe isso', async () => {
    const frases = [
      [{ start: 0, end: 4, text: 'Bom dia, vamos começar.' }, { start: 5, end: 9, text: 'Eu termino o relatório.' }],
      [{ start: 1, end: 6, text: 'Então fechamos sexta.' }],
    ];
    let n = 0;
    const { svc, deps, cfg } = make(
      CLEAN,
      { transcribe: vi.fn().mockImplementation(async () => ({ text: 'x', seconds: 25, segments: frases[n++] })) as never },
      {
        enabled: true,
        // trecho 0 = 0–25 s, trecho 1 = 25–50 s
        diarizar: vi.fn().mockResolvedValue({
          pessoas: 2,
          turnos: [
            { inicio: 0, fim: 4.5, pessoa: 1 },
            { inicio: 4.8, fim: 9.5, pessoa: 2 },
            { inicio: 25.5, fim: 31, pessoa: 1 },
          ],
        }),
      },
    );
    const m = svc.start('Semanal');
    await svc.addSegment(m.id, Buffer.from('a'));
    await svc.addSegment(m.id, Buffer.from('b'));
    const fim = await svc.stop(m.id);

    expect(fim.pessoas).toBe(2);
    expect(fim.falas?.map((f) => [f.pessoa, f.texto])).toEqual([
      [1, 'Bom dia, vamos começar.'],
      [2, 'Eu termino o relatório.'],
      [1, 'Então fechamos sexta.'],
    ]);
    const prompt = (deps.llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0][1].content as string;
    expect(prompt).toContain('Pessoa 2: Eu termino o relatório.');
    // o áudio vai embora quando a ata fica pronta
    expect(() => readdirSync(join(cfg.DATA_DIR, 'meetings', `${m.id}.audio`))).toThrow();
  });

  it('se o serviço de vozes falhar, a ata sai do jeito de antes', async () => {
    const { svc } = make(CLEAN, undefined, { enabled: true, diarizar: vi.fn().mockResolvedValue(null) });
    const m = svc.start();
    await svc.addSegment(m.id, Buffer.from('a'));
    const fim = await svc.stop(m.id);
    expect(fim.falas).toBeUndefined();
    expect(fim.ata?.decisoes).toEqual(['Lançar na sexta']);
  });

  it('ata que estava saindo quando o servidor reiniciou é retomada', async () => {
    const { svc, novo, deps } = make(CLEAN);
    (deps.llm.complete as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => {})); // trava no meio
    const m = svc.start();
    await svc.addSegment(m.id, Buffer.from('a'));
    svc.finish(m.id);
    await new Promise((r) => setTimeout(r, 10));

    const depois = novo();
    depois.onModuleInit();
    await vi.waitFor(() => expect(depois.get(m.id)?.status).toBe('pronta'));
    expect(depois.get(m.id)?.ata?.decisoes).toEqual(['Lançar na sexta']);
  });

  it('quemFalou: quem mais fala no intervalo; sem sobreposição, o turno mais perto', () => {
    const turnos = [
      { inicio: 0, fim: 5, pessoa: 1 },
      { inicio: 5, fim: 10, pessoa: 2 },
    ];
    expect(quemFalou(turnos, 3, 9)).toBe(2); // 2 s da pessoa 1, 4 s da pessoa 2
    expect(quemFalou(turnos, 12, 13)).toBe(2);
  });
});
