import { describe, expect, it, vi } from 'vitest';
import type { ChatService } from '../chat/chat.service.js';
import type { AppConfig } from '../config/app-config.js';
import type { SilencioService } from '../proactive/silencio.service.js';
import type { RobotStateService } from '../robot/robot-state.service.js';
import { RecadoTokenGuard } from './recado-token.guard.js';
import { RecadosAppsService } from './recados-apps.service.js';
import { RecadosService } from './recados.service.js';
import { NovoRecado, REAVISO_MS, RecadosStore } from './recados.store.js';

const recado = (r: Record<string, unknown>) => NovoRecado.parse(r);
const T0 = Date.UTC(2026, 10, 4, 15, 0); // quarta, 12h em São Paulo

function make(opts: { silencio?: string | null } = {}) {
  const cfg = { DATA_DIR: '', TZ_NAME: 'America/Sao_Paulo' } as unknown as AppConfig;
  const store = new RecadosStore(cfg);
  const apps = new RecadosAppsService(cfg);
  const robotSay = vi.fn();
  const say = vi.fn();
  const motivo = vi.fn().mockReturnValue(opts.silencio ?? null);
  const svc = new RecadosService(
    cfg,
    store,
    { robotSay } as unknown as ChatService,
    { say } as unknown as RobotStateService,
    { motivo } as unknown as SilencioService,
    apps,
  );
  return { store, svc, robotSay, say, motivo, apps };
}

describe('NovoRecado', () => {
  it('exige título, a não ser para fechar', () => {
    expect(NovoRecado.safeParse({ texto: 'oi' }).success).toBe(false);
    expect(NovoRecado.safeParse({ chave: 'x', resolvido: true }).success).toBe(true);
  });

  it('fechar exige a chave', () => {
    expect(NovoRecado.safeParse({ resolvido: true }).success).toBe(false);
  });

  it('link só http(s) e prioridade conhecida', () => {
    expect(NovoRecado.safeParse({ titulo: 'a', link: 'javascript:alert(1)' }).success).toBe(false);
    expect(NovoRecado.safeParse({ titulo: 'a', prioridade: 'altissima' }).success).toBe(false);
    expect(recado({ titulo: 'a' })).toMatchObject({ tipo: 'outro', prioridade: 'normal', resolvido: false });
  });
});

describe('RecadosStore', () => {
  it('mesma chave atualiza o recado aberto e sobe a prioridade', () => {
    const { store } = make();
    const a = store.receber('baixaxml', recado({ titulo: 'Chamado 1', chave: 'suporte:1' }), T0);
    const b = store.receber('baixaxml', recado({ titulo: 'Chamado 1', texto: 'de novo', chave: 'suporte:1', prioridade: 'urgente' }), T0 + 1000);
    expect(a.novo).toBe(true);
    expect(b.novo).toBe(false);
    expect(store.abertos()).toHaveLength(1);
    expect(store.abertos()[0]).toMatchObject({ vezes: 2, prioridade: 'urgente', texto: 'de novo' });
  });

  it('a chave é por aplicação', () => {
    const { store } = make();
    store.receber('baixaxml', recado({ titulo: 'a', chave: 'k' }), T0);
    store.receber('outro', recado({ titulo: 'b', chave: 'k' }), T0);
    expect(store.abertos()).toHaveLength(2);
  });

  it('resolvido fecha; sem nada aberto, não cria', () => {
    const { store } = make();
    expect(store.receber('baixaxml', recado({ chave: 'saude', resolvido: true }), T0).recado).toBeNull();
    store.receber('baixaxml', recado({ titulo: 'Fonte caiu', chave: 'saude' }), T0);
    store.receber('baixaxml', recado({ chave: 'saude', resolvido: true }), T0 + 1000);
    expect(store.abertos()).toHaveLength(0);
  });

  it('dar baixa por id ou todos de um app', () => {
    const { store } = make();
    const { recado: a } = store.receber('baixaxml', recado({ titulo: 'a' }), T0);
    store.receber('baixaxml', recado({ titulo: 'b' }), T0);
    store.receber('outro', recado({ titulo: 'c' }), T0);
    expect(store.darBaixa([a!.id]).map((r) => r.titulo)).toEqual(['a']);
    expect(store.darBaixa([], { todos: true, app: 'baixaxml' }).map((r) => r.titulo)).toEqual(['b']);
    expect(store.abertos().map((r) => r.titulo)).toEqual(['c']);
  });

  it('resumo por app e tipo', () => {
    const { store } = make();
    store.receber('baixaxml', recado({ titulo: 'a', tipo: 'suporte' }), T0);
    store.receber('baixaxml', recado({ titulo: 'b', tipo: 'suporte', prioridade: 'urgente' }), T0);
    store.receber('baixaxml', recado({ titulo: 'c', tipo: 'cadastro', prioridade: 'baixa' }), T0);
    expect(store.resumo()).toBe('3 abertos — baixaxml: 2 suporte, 1 cadastro (1 urgente)');
  });
});

describe('RecadosService.entregar', () => {
  it('normal no horário vai na hora, para o chat', () => {
    const { svc, robotSay, say, store } = make();
    store.receber('baixaxml', recado({ titulo: 'Chamado novo', tipo: 'suporte', texto: 'o lote parou' }), T0);
    svc.entregar(T0);
    expect(robotSay).toHaveBeenCalledOnce();
    expect(robotSay.mock.calls[0]![0]).toContain('baixaxml · suporte: Chamado novo');
    expect(robotSay.mock.calls[0]![2]).toBe('recado');
    expect(say).not.toHaveBeenCalled(); // balão da tela só para urgente
  });

  it('baixa prioridade não vai sozinha', () => {
    const { svc, robotSay, store } = make();
    store.receber('baixaxml', recado({ titulo: 'Cadastro novo', tipo: 'cadastro', prioridade: 'baixa' }), T0);
    svc.entregar(T0);
    expect(robotSay).not.toHaveBeenCalled();
  });

  it('em silêncio, normal espera e urgente fura', () => {
    const { svc, robotSay, say, store, motivo } = make({ silencio: 'folga de sábado' });
    store.receber('baixaxml', recado({ titulo: 'Chamado', tipo: 'suporte' }), T0);
    svc.entregar(T0);
    expect(robotSay).not.toHaveBeenCalled();

    store.receber('baixaxml', recado({ titulo: 'Fora do ar', tipo: 'saude', prioridade: 'urgente' }), T0);
    svc.entregar(T0);
    expect(robotSay).toHaveBeenCalledOnce();
    expect(robotSay.mock.calls[0]![0]).toContain('🚨');
    expect(say).toHaveBeenCalledWith('baixaxml: Fora do ar', 15_000);

    // Acabou o silêncio: o chamado guardado sai no próximo tick.
    motivo.mockReturnValue(null);
    svc.entregar(T0 + 60_000);
    expect(robotSay).toHaveBeenCalledTimes(2);
    expect(robotSay.mock.calls[1]![0]).toContain('Chamado');
  });

  it('de madrugada normal espera', () => {
    const { svc, robotSay, store } = make();
    const madrugada = Date.UTC(2026, 10, 4, 6, 0); // 3h em São Paulo
    store.receber('baixaxml', recado({ titulo: 'Chamado' }), madrugada);
    svc.entregar(madrugada);
    expect(robotSay).not.toHaveBeenCalled();
  });

  it('atualizações do mesmo recado se juntam numa janela', () => {
    const { svc, robotSay, store } = make();
    store.receber('baixaxml', recado({ titulo: 'Chamado 7', chave: 'suporte:7' }), T0);
    svc.entregar(T0);
    store.receber('baixaxml', recado({ titulo: 'Chamado 7', chave: 'suporte:7' }), T0 + 60_000);
    store.receber('baixaxml', recado({ titulo: 'Chamado 7', chave: 'suporte:7' }), T0 + 120_000);
    svc.entregar(T0 + 120_000);
    expect(robotSay).toHaveBeenCalledOnce();
    svc.entregar(T0 + REAVISO_MS);
    expect(robotSay).toHaveBeenCalledTimes(2);
    expect(robotSay.mock.calls[1]![0]).toContain('(3x)');
    svc.entregar(T0 + 3 * REAVISO_MS); // sem novidade, não repete
    expect(robotSay).toHaveBeenCalledTimes(2);
  });

  it('vários de uma vez viram uma mensagem só', () => {
    const { svc, robotSay, store } = make();
    store.receber('baixaxml', recado({ titulo: 'a' }), T0);
    store.receber('baixaxml', recado({ titulo: 'b' }), T0);
    svc.entregar(T0);
    expect(robotSay).toHaveBeenCalledOnce();
    expect(robotSay.mock.calls[0]![0]).toMatch(/^📨 2 recados/);
  });

  it('conta que normalizou só se tinha avisado do problema', () => {
    const { svc, robotSay, store } = make();
    store.receber('baixaxml', recado({ titulo: 'Fonte caiu', chave: 'saude', prioridade: 'urgente' }), T0);
    svc.entregar(T0);
    store.receber('baixaxml', recado({ chave: 'saude', resolvido: true }), T0 + 1000);
    svc.entregar(T0 + 1000);
    expect(robotSay).toHaveBeenCalledTimes(2);
    expect(robotSay.mock.calls[1]![0]).toBe('✅ baixaxml: Fonte caiu — resolvido.');

    // Baixa prioridade fechada: ele nunca soube, não precisa saber que fechou.
    store.receber('baixaxml', recado({ titulo: 'x', chave: 'c', prioridade: 'baixa' }), T0);
    store.receber('baixaxml', recado({ chave: 'c', resolvido: true }), T0);
    svc.entregar(T0 + 2000);
    expect(robotSay).toHaveBeenCalledTimes(2);
  });

  it('limite por minuto por aplicação', () => {
    const { svc } = make();
    for (let i = 0; i < 60; i++) expect(svc.dentroDoRitmo('baixaxml', T0)).toBe(true);
    expect(svc.dentroDoRitmo('baixaxml', T0)).toBe(false);
    expect(svc.dentroDoRitmo('outro', T0)).toBe(true);
    expect(svc.dentroDoRitmo('baixaxml', T0 + 61_000)).toBe(true);
  });
});

describe('RecadosAppsService', () => {
  const novo = () => new RecadosAppsService({ DATA_DIR: '' });

  it('cria com chave que aparece uma vez e não é guardada', () => {
    const apps = novo();
    const r = apps.criar('baixaxml', 'https://baixaxml.example/health');
    if ('erro' in r) throw new Error(r.erro);
    expect(r.token).toMatch(/^rcd_[\w-]{43}$/);
    expect(r.app.prefixo).toBe(r.token.slice(0, 8));
    expect(JSON.stringify(apps.listar())).not.toContain(r.token.slice(8));
    expect(apps.listar()[0]).not.toHaveProperty('hash');
    expect(apps.autenticar(r.token)?.nome).toBe('baixaxml');
    expect(apps.vigiadas()).toEqual([{ app: 'baixaxml', url: 'https://baixaxml.example/health' }]);
  });

  it('nome repetido não', () => {
    const apps = novo();
    apps.criar('baixaxml');
    expect(apps.criar('baixaxml')).toHaveProperty('erro');
  });

  it('chave nova derruba a antiga', () => {
    const apps = novo();
    const r = apps.criar('baixaxml');
    if ('erro' in r) throw new Error(r.erro);
    const nova = apps.novaChave('baixaxml')!;
    expect(apps.autenticar(r.token)).toBeNull();
    expect(apps.autenticar(nova)?.nome).toBe('baixaxml');
  });

  it('desativada não é vigiada; apagada não autentica', () => {
    const apps = novo();
    const r = apps.criar('baixaxml', 'https://x.example/health');
    if ('erro' in r) throw new Error(r.erro);
    apps.mudar('baixaxml', { ativo: false });
    expect(apps.vigiadas()).toEqual([]);
    expect(apps.autenticar(r.token)?.ativo).toBe(false);
    apps.apagar('baixaxml');
    expect(apps.autenticar(r.token)).toBeNull();
  });

  it('conta os recados recebidos, menos os da sonda', () => {
    const { svc, apps } = make();
    apps.criar('baixaxml');
    svc.receber('baixaxml', recado({ titulo: 'a' }));
    svc.receber('baixaxml', recado({ titulo: 'Fora do ar', chave: 'vigia:health' }));
    expect(apps.get('baixaxml')).toMatchObject({ recebidos: 1 });
  });
});

describe('RecadoTokenGuard', () => {
  const apps = new RecadosAppsService({ DATA_DIR: '' });
  const a = apps.criar('baixaxml') as { token: string };
  const b = apps.criar('outro') as { token: string };
  const ctx = (authorization?: string) => {
    const req: Record<string, unknown> = { headers: { authorization } };
    return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }) } as never };
  };

  it('descobre a aplicação pela chave', () => {
    const { req, ctx: c } = ctx(`Bearer ${b.token}`);
    expect(new RecadoTokenGuard(apps).canActivate(c)).toBe(true);
    expect(req.recadoApp).toBe('outro');
  });

  it('sem chave ou chave errada: 401; desativada: 403', () => {
    expect(() => new RecadoTokenGuard(apps).canActivate(ctx().ctx)).toThrow(/Unauthorized/);
    expect(() => new RecadoTokenGuard(apps).canActivate(ctx('Bearer rcd_errado').ctx)).toThrow(/Unauthorized/);
    apps.mudar('baixaxml', { ativo: false });
    expect(() => new RecadoTokenGuard(apps).canActivate(ctx(`Bearer ${a.token}`).ctx)).toThrow(/desativada/);
  });
});

describe('zipDaSkill', () => {
  it('zipa a skill dentro de miro-recados/ e troca o endereço', async () => {
    const { zipDaSkill } = await import('./skill-zip.js');
    const { rootPath } = await import('../config/paths.js');
    const z = zipDaSkill(rootPath('../../tools/miro-recados-skill'), (t) => t.replaceAll('https://srv1966497.hstgr.cloud', 'https://exemplo.test'));
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    const nomes = z.toString('latin1');
    for (const n of ['miro-recados/SKILL.md', 'miro-recados/clientes/nestjs.ts', 'miro-recados/clientes/python.py']) expect(nomes).toContain(n);
  });
});
