import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { BracoService } from './braco.service.js';

/** Um braço de mentira: guarda o que foi enviado para podermos responder no lugar da máquina. */
function fakeWs() {
  const enviados: { t: string; id: string; acao?: string; cmd?: string; args?: Record<string, string> }[] = [];
  return {
    ws: { send: vi.fn((raw: string) => enviados.push(JSON.parse(raw))) } as unknown as WebSocket,
    enviados,
  };
}

const ACOES = [{ nome: 'espaco_em_disco', descricao: 'quanto sobra', params: [] }];

describe('BracoService', () => {
  it('sem máquina conectada, não tenta nada', async () => {
    const svc = new BracoService();
    expect(svc.online).toBe(false);
    expect(await svc.rodarComando('ls')).toMatchObject({ ok: false, erro: expect.stringContaining('não está conectada') });
  });

  it('recusa ação que a máquina não anunciou', async () => {
    const svc = new BracoService();
    const { ws, enviados } = fakeWs();
    svc.conectou(ws, 'pc', ACOES);

    const r = await svc.rodarAcao('formatar_tudo');
    expect(r.ok).toBe(false);
    expect(r.erro).toContain('não conhece a ação');
    expect(enviados).toEqual([]); // nem chegou a sair do servidor
  });

  it('manda a ação e devolve a saída que a máquina respondeu', async () => {
    const svc = new BracoService();
    const { ws, enviados } = fakeWs();
    svc.conectou(ws, 'pc', ACOES);

    const promessa = svc.rodarAcao('espaco_em_disco');
    expect(enviados[0]).toMatchObject({ t: 'run', acao: 'espaco_em_disco' });

    svc.resultado(enviados[0]!.id, { ok: true, saida: '42G livres' });
    await expect(promessa).resolves.toEqual({ ok: true, saida: '42G livres' });
  });

  it('resposta de um id que ninguém espera é ignorada', () => {
    const svc = new BracoService();
    const { ws } = fakeWs();
    svc.conectou(ws, 'pc', ACOES);
    expect(() => svc.resultado('id-que-nao-existe', { ok: true, saida: 'oi' })).not.toThrow();
  });

  it('se a máquina cai no meio, quem estava esperando recebe erro em vez de travar', async () => {
    const svc = new BracoService();
    const { ws } = fakeWs();
    svc.conectou(ws, 'pc', ACOES);

    const promessa = svc.rodarComando('sleep 999');
    svc.desconectou();

    await expect(promessa).resolves.toMatchObject({ ok: false, erro: expect.stringContaining('desconectou') });
    expect(svc.online).toBe(false);
    expect(svc.acoes()).toEqual([]);
  });

  it('corta saída gigante para não entupir o chat', async () => {
    const svc = new BracoService();
    const { ws, enviados } = fakeWs();
    svc.conectou(ws, 'pc', ACOES);

    const promessa = svc.rodarComando('gera_muito_texto');
    svc.resultado(enviados[0]!.id, { ok: true, saida: 'x'.repeat(10_000) });
    const r = await promessa;
    expect(r.saida.length).toBe(4000);
  });

  describe('várias máquinas (o app no Linux e no Windows ao mesmo tempo)', () => {
    it('sem dizer qual, vai para a que o dono está usando', async () => {
      const svc = new BracoService();
      const linux = fakeWs();
      const win = fakeWs();
      svc.conectou(linux.ws, 'arch', [], 'linux');
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
      svc.conectou(win.ws, 'DESKTOP-WIN', [], 'windows');
      expect(svc.maquinas().map((m) => m.nome)).toEqual(['DESKTOP-WIN', 'arch']);

      void svc.rodarComando('Get-Date');
      expect(win.enviados[0]).toMatchObject({ t: 'run', cmd: 'Get-Date' });
      expect(linux.enviados).toEqual([]);

      // Ele voltou a mexer no Linux: agora é a padrão.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
      svc.ativa(linux.ws);
      void svc.rodarComando('date');
      expect(linux.enviados[0]).toMatchObject({ cmd: 'date' });
      vi.restoreAllMocks();
    });

    it('escolhe pelo nome (ou pedaço dele, ou pelo sistema)', () => {
      const svc = new BracoService();
      svc.conectou(fakeWs().ws, 'arch', [], 'linux');
      svc.conectou(fakeWs().ws, 'DESKTOP-WIN', [], 'windows');
      expect(svc.escolher('desktop-win')?.nome).toBe('DESKTOP-WIN');
      expect(svc.escolher('win')?.nome).toBe('DESKTOP-WIN');
      expect(svc.escolher('linux')?.nome).toBe('arch');
      expect(svc.escolher('notebook')).toBeNull();
    });

    it('uma cair não derruba a outra, e reconectar com o mesmo nome substitui', async () => {
      const svc = new BracoService();
      const a = fakeWs();
      const b = fakeWs();
      svc.conectou(a.ws, 'arch', [], 'linux');
      svc.conectou(b.ws, 'DESKTOP-WIN', [], 'windows');
      svc.desconectou(a.ws);
      expect(svc.maquinas().map((m) => m.nome)).toEqual(['DESKTOP-WIN']);

      const b2 = fakeWs();
      svc.conectou(b2.ws, 'DESKTOP-WIN', [], 'windows');
      expect(svc.maquinas()).toHaveLength(1);
      void svc.rodarComando('dir');
      expect(b2.enviados).toHaveLength(1);
      expect(b.enviados).toHaveLength(0);
    });

    it('máquina com nome errado: diz quais estão conectadas', async () => {
      const svc = new BracoService();
      svc.conectou(fakeWs().ws, 'arch', [], 'linux');
      const r = await svc.rodarComando('ls', 'notebook');
      expect(r).toMatchObject({ ok: false, erro: expect.stringContaining('conectadas: arch') });
    });
  });
});
