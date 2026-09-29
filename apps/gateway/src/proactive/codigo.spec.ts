import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BracoService, Olhada } from '../braco/braco.service.js';
import type { ChatService } from '../chat/chat.service.js';
import type { AppConfig } from '../config/app-config.js';
import type { IdentidadeService } from '../identidade/identidade.service.js';
import type { LlmService } from '../llm/llm.service.js';
import type { MeetingService } from '../meeting/meeting.service.js';
import { CodigoService, lerComentario } from './codigo.service.js';

const olhada = (diff = '+ console.log("aqui")'): Olhada => ({ maquina: 'arch', projeto: 'robot_assistant', arquivo: 'main.ts', diff, commits: '' });

function montar(resposta = '{"comentario": "Esse console.log vai pra produção, hein?", "expressao": "feliz"}') {
  const olhou$ = new Subject<Olhada>();
  const llm = { enabled: true, complete: vi.fn(async () => ({ content: resposta })) };
  const chat = { robotSay: vi.fn(), lastActivityAt: vi.fn(() => 0) };
  const meetings = { gravando: false };
  const svc = new CodigoService(
    { TZ_NAME: 'America/Sao_Paulo', OWNER_NAME: 'Jean' } as unknown as AppConfig,
    { olhou$ } as unknown as BracoService,
    chat as unknown as ChatService,
    llm as unknown as LlmService,
    { nome: 'Miro' } as unknown as IdentidadeService,
    meetings as unknown as MeetingService,
  );
  svc.onModuleInit();
  const olhar = async (o = olhada()) => {
    olhou$.next(o);
    await vi.waitFor(() => undefined);
    await new Promise((r) => setImmediate(r));
  };
  return { svc, llm, chat, meetings, olhar };
}

describe('o Miro comentando o código', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T14:00:00-03:00')); // quarta, 14h
  });
  afterEach(() => vi.useRealTimers());

  it('comenta no balão só daquele computador', async () => {
    const { chat, olhar } = montar();
    await olhar();
    expect(chat.robotSay).toHaveBeenCalledWith('Esse console.log vai pra produção, hein?', 'happy', 'codigo', { paraMaquina: 'arch' });
  });

  it('nada que valha: fica quieto', async () => {
    const { chat, llm, olhar } = montar('{"calar": true}');
    await olhar();
    expect(llm.complete).toHaveBeenCalledOnce();
    expect(chat.robotSay).not.toHaveBeenCalled();
  });

  it('comentou há pouco: nem olha (não gasta a cota)', async () => {
    const { llm, olhar } = montar();
    await olhar();
    vi.setSystemTime(new Date('2026-09-30T14:20:00-03:00'));
    await olhar(olhada('+ outra mudança'));
    expect(llm.complete).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date('2026-09-30T14:45:00-03:00'));
    await olhar(olhada('+ mais uma'));
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });

  it('fora do horário, em reunião ou conversando com ele: não olha', async () => {
    const { svc, meetings, chat } = montar();
    vi.setSystemTime(new Date('2026-09-30T22:30:00-03:00'));
    expect(svc.motivoParaNao()).toBe('fora do horário');
    vi.setSystemTime(new Date('2026-09-30T14:00:00-03:00'));
    meetings.gravando = true;
    expect(svc.motivoParaNao()).toBe('reunião gravando');
    meetings.gravando = false;
    chat.lastActivityAt.mockReturnValue(Date.now() - 60_000);
    expect(svc.motivoParaNao()).toBe('estão conversando');
  });

  it('no máximo 6 comentários por dia', async () => {
    const { chat, olhar } = montar();
    for (let h = 0; h < 8; h++) {
      vi.setSystemTime(new Date(`2026-09-30T${String(9 + h).padStart(2, '0')}:00:00-03:00`));
      await olhar(olhada(`+ mudança ${h}`));
    }
    expect(chat.robotSay).toHaveBeenCalledTimes(6);
  });
});

describe('lerComentario', () => {
  it('lê o JSON, e calar/vazio/fora do formato viram silêncio', () => {
    expect(lerComentario('```json\n{"comentario":"Boa, mas falta o teste","expressao":"Pensativo"}\n```')).toEqual({ texto: 'Boa, mas falta o teste', expressao: 'pensativo' });
    expect(lerComentario('{"calar": true}')).toBeNull();
    expect(lerComentario('{"comentario": ""}')).toBeNull();
    expect(lerComentario('achei legal')).toBeNull();
  });
});
