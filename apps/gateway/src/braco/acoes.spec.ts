import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { AppConfig } from '../config/app-config.js';
import { AcoesService, escapar, montar, nomeDe, paramsDe } from './acoes.service.js';
import { BracoService } from './braco.service.js';

const novoCadastro = () => new AcoesService({ DATA_DIR: mkdtempSync(join(tmpdir(), 'acoes-')) } as AppConfig);

function fakeWs() {
  const enviados: { t: string; id: string; acao?: string; cmd?: string }[] = [];
  return { ws: { send: vi.fn((raw: string) => enviados.push(JSON.parse(raw))) } as unknown as WebSocket, enviados };
}

describe('ações do painel', () => {
  it('nome sai da descrição, params saem do comando', () => {
    expect(nomeDe('Abrir o projeto no VS Code')).toBe('abrir_o_projeto_no_vs_code');
    expect(paramsDe('code ~/Projects/{projeto} && echo {projeto} {arquivo}')).toEqual(['projeto', 'arquivo']);
  });

  it('argumento nunca vira comando, no sh e no PowerShell', () => {
    expect(montar({ comando: 'code ~/p/{x}', sistema: 'linux' }, { x: "a'; rm -rf ~" })).toBe(`code ~/p/'a'\\''; rm -rf ~'`);
    expect(escapar("a'; Remove-Item", 'windows')).toBe(`'a''; Remove-Item'`);
    expect(() => montar({ comando: 'x {y}', sistema: 'linux' }, {})).toThrow('falta o argumento');
  });

  it('cada máquina vê só as do seu sistema (e as presas a ela)', () => {
    const c = novoCadastro();
    c.criar({ descricao: 'Bloquear a tela', comando: 'loginctl lock-session', sistema: 'linux' });
    c.criar({ descricao: 'Bloquear a tela', comando: 'rundll32.exe user32.dll,LockWorkStation', sistema: 'windows' });
    c.criar({ descricao: 'Só no notebook', comando: 'true', sistema: 'linux', maquina: 'notebook' });
    expect(c.para('arch', 'linux').map((a) => a.nome)).toEqual(['bloquear_a_tela']);
    expect(c.para('notebook', 'linux')).toHaveLength(2);
    expect(c.para('DESKTOP', 'windows').map((a) => a.nome)).toEqual(['bloquear_a_tela_2']);
  });

  it('o braço roda a ação do painel mandando o comando já montado', async () => {
    const c = novoCadastro();
    c.criar({ descricao: 'Abrir projeto', comando: 'code ~/Projects/{projeto}', sistema: 'linux' });
    const svc = new BracoService(c);
    const { ws, enviados } = fakeWs();
    svc.conectou(ws, 'arch', [], 'linux');

    expect(svc.maquinas()[0]!.acoes).toEqual([{ nome: 'abrir_projeto', descricao: 'Abrir projeto', params: ['projeto'] }]);
    void svc.rodarAcao('abrir_projeto', { projeto: 'robot_assistant' });
    expect(enviados[0]).toMatchObject({ t: 'run', cmd: "code ~/Projects/'robot_assistant'" });
    expect(enviados[0]!.acao).toBeUndefined();
  });

  it('ação de outro sistema não roda', async () => {
    const c = novoCadastro();
    c.criar({ descricao: 'Bloquear', comando: 'rundll32.exe user32.dll,LockWorkStation', sistema: 'windows' });
    const svc = new BracoService(c);
    svc.conectou(fakeWs().ws, 'arch', [], 'linux');
    expect(await svc.rodarAcao('bloquear')).toMatchObject({ ok: false, erro: expect.stringContaining('não conhece') });
  });

  it('editar e apagar', () => {
    const c = novoCadastro();
    const a = c.criar({ descricao: 'Abrir pasta', comando: 'xdg-open ~', sistema: 'linux' });
    expect(c.editar(a.id, { descricao: 'Abrir downloads', comando: 'xdg-open ~/Downloads', sistema: 'linux' })?.nome).toBe('abrir_downloads');
    expect(c.apagar(a.id)).toBe(true);
    expect(c.listar()).toEqual([]);
  });

  describe('ligar pela rede (Wake-on-LAN)', () => {
    it('lembra o MAC de quem conectou e pede ao robô para ligar quando estiver desligado', () => {
      const c = novoCadastro();
      const svc = new BracoService(c);
      const pedidos: string[] = [];
      svc.wol$.subscribe((mac) => pedidos.push(mac));
      const { ws } = fakeWs();
      svc.conectou(ws, 'arch', [], 'linux', '74:56:3c:f4:8d:1e');

      expect(svc.ligar('arch')).toMatchObject({ ok: true, texto: expect.stringContaining('já está ligado') });
      svc.desconectou(ws);
      expect(svc.desligadas()).toEqual([{ nome: 'arch', sistema: 'linux', podeLigar: true }]);

      expect(svc.ligar()).toMatchObject({ ok: false, texto: expect.stringContaining('robô da mesa') });
      svc.roboNaRede = true;
      expect(svc.ligar()).toMatchObject({ ok: true });
      expect(pedidos).toEqual(['74:56:3c:f4:8d:1e']);
    });

    it('sem MAC ou nome desconhecido, explica em vez de fingir', () => {
      const c = novoCadastro();
      const svc = new BracoService(c);
      svc.roboNaRede = true;
      const { ws } = fakeWs();
      svc.conectou(ws, 'velho', [], 'linux');
      svc.desconectou(ws);
      expect(svc.ligar('velho').texto).toContain('endereço de rede');
      expect(svc.ligar('notebook').texto).toContain('não conheço');
    });
  });
});

