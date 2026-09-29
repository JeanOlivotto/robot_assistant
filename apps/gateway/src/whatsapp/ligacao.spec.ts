import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { AppReuniao } from '@robo/protocol';
import type { BracoService } from '../braco/braco.service.js';
import { ChatService } from '../chat/chat.service.js';
import { ChatStore } from '../chat/chat.store.js';
import type { AppConfig } from '../config/app-config.js';
import { LigacaoService } from './ligacao.service.js';
import type { Ligacao, WhatsappService } from './whatsapp.service.js';

function montar() {
  const cfg = { DATA_DIR: mkdtempSync(join(tmpdir(), 'ligacao-')), TZ_NAME: 'America/Sao_Paulo', OWNER_NAME: 'Jean' } as unknown as AppConfig;
  const store = new ChatStore(cfg);
  const braco = { escolher: () => ({ nome: 'arch' }) } as unknown as BracoService;
  const chat = new ChatService(cfg, store, {} as never, {} as never, braco, {} as never, {} as never);
  const ligacao$ = new Subject<Ligacao>();
  new LigacaoService({ ligacao$ } as unknown as WhatsappService, chat).onModuleInit();
  const pedidos: AppReuniao[] = [];
  chat.reuniao$.subscribe((r) => pedidos.push(r));
  const cartao = (id: string) => chat.history(50).find((m) => m.proposal?.ligacao === id);
  const ligar = (id: string, fase: Ligacao['fase'], nome = 'Eduardo') => ligacao$.next({ id, nome, grupo: false, video: false, fase });
  return { chat, pedidos, cartao, ligar };
}

describe('ligação no WhatsApp', () => {
  it('avisa com o botão de gravar — uma vez só por ligação', () => {
    const { chat, cartao, ligar } = montar();
    ligar('L1', 'chegando');
    ligar('L1', 'chegando');
    const m = cartao('L1');
    expect(m?.text).toContain('Eduardo está te ligando');
    expect(m?.proposal).toMatchObject({ kind: 'reuniao', title: 'Ligação com Eduardo', status: 'pending' });
    expect(chat.history(50).filter((x) => x.proposal).length).toBe(1);
  });

  it('"Grava": manda o PC em uso gravar, a reunião leva o título, e encerra quando a ligação acaba', async () => {
    const { chat, pedidos, cartao, ligar } = montar();
    ligar('L1', 'chegando');
    await chat.confirm(cartao('L1')!.proposal!.id, true);
    expect(cartao('L1')?.proposal?.status).toBe('confirmed');
    expect(pedidos).toEqual([expect.objectContaining({ acao: 'gravar', ligacao: 'L1', maquina: 'arch' })]);

    expect(chat.reuniaoDaLigacao('R1')).toBe('Ligação com Eduardo');
    expect(chat.reuniaoDaLigacao('R2')).toBeUndefined(); // a próxima reunião já não é a ligação

    ligar('L1', 'acabou');
    expect(pedidos.at(-1)).toMatchObject({ acao: 'encerrar', ligacao: 'L1', reuniao: 'R1' });
  });

  it('ligação que acaba sem resposta: o cartão expira e nada grava', () => {
    const { pedidos, cartao, ligar } = montar();
    ligar('L2', 'chegando');
    ligar('L2', 'acabou');
    expect(cartao('L2')?.proposal?.status).toBe('expired');
    expect(pedidos).toEqual([]);
  });

  it('"não": não grava', async () => {
    const { chat, pedidos, cartao, ligar } = montar();
    ligar('L3', 'chegando');
    await chat.confirm(cartao('L3')!.proposal!.id, false);
    expect(cartao('L3')?.proposal?.status).toBe('cancelled');
    expect(pedidos).toEqual([]);
    expect(chat.reuniaoDaLigacao('R1')).toBeUndefined();
  });
});
