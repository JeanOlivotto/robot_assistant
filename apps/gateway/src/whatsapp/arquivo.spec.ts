import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Proposal } from '@robo/protocol';
import type { BracoService, Resultado } from '../braco/braco.service.js';
import { ChatService } from '../chat/chat.service.js';
import { ChatStore } from '../chat/chat.store.js';
import type { AppConfig } from '../config/app-config.js';
import { type WhatsappService, tipoDoArquivo } from './whatsapp.service.js';

function montar(arquivo: Resultado) {
  const cfg = { DATA_DIR: mkdtempSync(join(tmpdir(), 'arquivo-')), TZ_NAME: 'America/Sao_Paulo', OWNER_NAME: 'Jean' } as unknown as AppConfig;
  const store = new ChatStore(cfg);
  const braco = { pegarArquivo: vi.fn(async () => arquivo), escolher: () => ({ nome: 'arch' }) };
  const whatsapp = { enviar: vi.fn(async () => 'id'), enviarArquivo: vi.fn(async () => 'id'), enviarAudio: vi.fn(async () => 'id') };
  const chat = new ChatService(cfg, store, {} as never, {} as never, braco as unknown as BracoService, {} as never, whatsapp as unknown as WhatsappService);
  const propor = (p: Partial<Proposal>) =>
    chat.robotSay('Mando?', 'neutral', 'reply', {
      proposal: { id: 'P1', kind: 'whatsapp', title: 'WhatsApp para Vitor', chat: 'vitor@s.whatsapp.net', destino: 'Vitor', texto: '', status: 'pending', ...p },
    });
  const status = () => chat.history(50).find((m) => m.proposal?.id === 'P1')?.proposal?.status;
  return { chat, braco, whatsapp, propor, status };
}

describe('mandar arquivo do computador no WhatsApp', () => {
  it('com o "sim", o arquivo vem do PC e vai inteiro, como anexo, com o texto de legenda', async () => {
    const dados = Buffer.from('conteúdo inteiro do relatório');
    const { chat, braco, whatsapp, propor, status } = montar({ ok: true, saida: '', arquivo: { nome: 'relatorio.pdf', dados } });
    propor({ arquivo: '~/Downloads/relatorio.pdf', texto: 'Segue o relatório' });
    expect(braco.pegarArquivo).not.toHaveBeenCalled(); // nada sai do PC antes do "sim"

    await chat.confirm('P1', true);
    expect(braco.pegarArquivo).toHaveBeenCalledWith('~/Downloads/relatorio.pdf', undefined);
    expect(whatsapp.enviarArquivo).toHaveBeenCalledWith('vitor@s.whatsapp.net', dados, 'relatorio.pdf', 'Segue o relatório');
    expect(whatsapp.enviar).not.toHaveBeenCalled(); // o texto foi de legenda, não separado
    expect(status()).toBe('confirmed');
  });

  it('o arquivo não veio (não existe, grande demais): nada é mandado e o cartão diz por quê', async () => {
    const { chat, whatsapp, propor, status } = montar({ ok: false, saida: '', erro: 'não achei o arquivo' });
    propor({ arquivo: '~/nada.pdf', texto: 'Segue' });
    await chat.confirm('P1', true);
    expect(whatsapp.enviarArquivo).not.toHaveBeenCalled();
    expect(whatsapp.enviar).not.toHaveBeenCalled();
    expect(status()).toBe('failed');
  });

  it('chave ou .env não sai nem com o "sim"', async () => {
    const { chat, braco, propor, status } = montar({ ok: true, saida: '', arquivo: { nome: 'id_rsa', dados: Buffer.from('x') } });
    propor({ arquivo: '~/.ssh/id_rsa' });
    await chat.confirm('P1', true);
    expect(braco.pegarArquivo).not.toHaveBeenCalled();
    expect(status()).toBe('failed');
  });

  it('o tipo vem do nome (o WhatsApp mostra o ícone certo)', () => {
    expect(tipoDoArquivo('Relatório.PDF')).toBe('application/pdf');
    expect(tipoDoArquivo('planilha.xlsx')).toContain('spreadsheetml');
    expect(tipoDoArquivo('sem-extensao')).toBe('application/octet-stream');
  });
});
