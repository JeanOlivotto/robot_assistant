import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import type { LlmService } from '../llm/llm.service.js';
import type { PushService } from '../push/push.service.js';
import { SttError, type SttService } from '../stt/stt.service.js';
import { TaskService } from '../tasks/task.service.js';
import { MeetingService } from './meeting.service.js';

function make(llmReply: string, stt?: Partial<SttService>) {
  const cfg = { DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-meet-')) } as unknown as AppConfig;
  const sttSvc = {
    enabled: true,
    transcribe: vi.fn().mockResolvedValue({ text: 'oi pessoal, decidimos lançar sexta', seconds: 5 }),
    ...stt,
  } as unknown as SttService;
  const llm = { enabled: true, complete: vi.fn().mockResolvedValue({ content: llmReply }) } as unknown as LlmService;
  const push = { notify: vi.fn().mockResolvedValue(1) } as unknown as PushService;
  // As ações da ata viram pendências: o serviço de verdade, num diretório temporário.
  const tasks = new TaskService(cfg);
  return { svc: new MeetingService(cfg, sttSvc, llm, push, tasks), push, tasks };
}

/** Como make(), mas devolve também o config e as dependências — para simular um reinício. */
function makeFull(llmReply: string) {
  const cfg = { DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-meet-')) } as unknown as AppConfig;
  const stt = {
    enabled: true,
    transcribe: vi.fn().mockResolvedValue({ text: 'oi pessoal, decidimos lançar sexta', seconds: 5 }),
  } as unknown as SttService;
  const llm = { enabled: true, complete: vi.fn().mockResolvedValue({ content: llmReply }) } as unknown as LlmService;
  const push = { notify: vi.fn().mockResolvedValue(1) } as unknown as PushService;
  const tasks = new TaskService(cfg);
  const deps = { stt, llm, push, tasks };
  return { svc: new MeetingService(cfg, stt, llm, push, tasks), cfg, deps };
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
    const { svc, push } = make(CLEAN);
    const m = svc.start('Planejamento');
    await svc.addSegment(m.id, Buffer.from('audio'));
    const done = await svc.stop(m.id);
    expect(done.ata?.resumo).toContain('lançamento');
    expect(done.ata?.decisoes).toEqual(['Lançar na sexta']);
    expect(done.ata?.acoes[0]).toEqual({ texto: 'Preparar release', responsavel: 'Fábio' });
    expect(done.ata?.acoes[1]).toEqual({ texto: 'Avisar clientes' });
    expect(push.notify).toHaveBeenCalledOnce();
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
    const { svc, cfg, deps } = makeFull(CLEAN);
    const m = svc.start('Reunião longa');
    await svc.addSegment(m.id, Buffer.from('audio'));

    // Deploy: o serviço sobe de novo, com a memória vazia, lendo o mesmo diretório.
    const depois = new MeetingService(cfg, deps.stt, deps.llm, deps.push, deps.tasks);
    expect(depois.list()).toEqual([]); // em andamento não aparece na lista de atas
    await depois.addSegment(m.id, Buffer.from('audio'));
    const fim = await depois.stop(m.id);
    expect(fim.segments).toBe(2);
    expect(fim.ata?.decisoes).toEqual(['Lançar na sexta']);
  });

  it('encerrar duas vezes não refaz a ata nem avisa de novo', async () => {
    const { svc, deps } = makeFull(CLEAN);
    const m = svc.start('Reunião');
    await svc.addSegment(m.id, Buffer.from('audio'));
    await svc.stop(m.id);
    await svc.stop(m.id);
    expect(deps.llm.complete).toHaveBeenCalledTimes(1);
    expect(deps.push.notify).toHaveBeenCalledTimes(1);
  });

  it('se o LLM cair, a transcrição fica guardada', async () => {
    const { svc, deps } = makeFull(CLEAN);
    (deps.llm.complete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('groq fora'));
    const m = svc.start('Reunião');
    await svc.addSegment(m.id, Buffer.from('audio'));
    const fim = await svc.stop(m.id);
    expect(fim.ata?.resumo).toContain('groq fora');
    expect(svc.get(m.id)?.transcript).toContain('decidimos lançar sexta');
  });
});
