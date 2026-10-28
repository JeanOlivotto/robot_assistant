import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@robo/protocol';
import type { AppConfig } from '../config/app-config.js';
import type { LlmService } from '../llm/llm.service.js';
import { MemoryService } from './memory.service.js';

const cfg = () => ({ DATA_DIR: mkdtempSync(join(tmpdir(), 'robo-mem-')), OWNER_NAME: 'Jean' }) as unknown as AppConfig;
const llm = (content: string, enabled = true) => ({ enabled, complete: vi.fn().mockResolvedValue({ content }) }) as unknown as LlmService;
const userMsg = (text: string): ChatMessage => ({ id: '1', from: 'user', text, ts: Date.now() });

describe('MemoryService', () => {
  it('não duplica assunto igual (normalizado) e conta menções', () => {
    const m = new MemoryService(cfg(), llm(''));
    m.note('Projeto do robô');
    m.note('projeto do robo!');
    expect(m.all()).toHaveLength(1);
    expect(m.all()[0]!.mentions).toBe(2);
  });

  it('clear esquece tudo e sobrevive a recarregar do disco', () => {
    const c = cfg();
    const m = new MemoryService(c, llm(''));
    m.note('projeto do robô');
    m.note('academia às terças');
    expect(m.all()).toHaveLength(2);

    expect(m.clear()).toBe(2);
    expect(m.all()).toEqual([]);
    // Um serviço novo lê o mesmo arquivo: o esquecimento tem que ter ido para o disco.
    expect(new MemoryService(c, llm('')).all()).toEqual([]);
  });

  it('stale devolve o assunto mais antigo além do limite', () => {
    const m = new MemoryService(cfg(), llm(''));
    m.note('academia');
    m.all()[0]!.lastSeenAt = Date.now() - 10 * 24 * 3600_000; // 10 dias atrás
    expect(m.stale(4)?.texto).toBe('academia');
    expect(m.stale(30)).toBeNull();
  });

  it('learn extrai assuntos do JSON do LLM', async () => {
    const m = new MemoryService(cfg(), llm('```json\n{"assuntos":["mudança de casa","curso de inglês"]}\n```'));
    await m.learn([userMsg('tô me mudando e comecei um curso de inglês')]);
    expect(m.summaries()).toEqual(expect.arrayContaining(['mudança de casa', 'curso de inglês']));
  });

  it('esquecer apaga as variações do assunto e deixa o resto', () => {
    const m = new MemoryService(cfg(), llm(''));
    m.note('Projeto jogo macaco');
    m.note('Desenvolver jogo macaco');
    m.note('projeto de fotos de macaco');
    m.note('esposa Duda');
    expect(m.esquecer('o jogo do macaco')).toHaveLength(2);
    expect(m.summaries()).toEqual(expect.arrayContaining(['projeto de fotos de macaco', 'esposa Duda']));
    expect(m.all()).toHaveLength(2);
    expect(m.esquecer('do')).toEqual([]); // palavra vazia não apaga tudo
  });

  it('learn tira o que o dono disse que era só teste', async () => {
    const m = new MemoryService(cfg(), llm('{"assuntos":[],"esquecer":["Projeto jogo macaco"]}'));
    m.note('Projeto jogo macaco');
    m.note('esposa Duda');
    await m.learn([userMsg('aquele jogo do macaco era só teste')]);
    expect(m.summaries()).toEqual(['esposa Duda']);
  });

  it('learn ignora resposta sem JSON', async () => {
    const m = new MemoryService(cfg(), llm('nada de relevante aqui'));
    await m.learn([userMsg('oi')]);
    expect(m.all()).toHaveLength(0);
  });

  it('learn persiste em disco e recarrega', async () => {
    const c = cfg();
    await new MemoryService(c, llm('{"assuntos":["novo emprego"]}')).learn([userMsg('consegui um novo emprego')]);
    expect(new MemoryService(c, llm('')).summaries()).toContain('novo emprego');
  });

  it('learn cria entidades e ligações e reaproveita a entidade pelo apelido', async () => {
    const m = new MemoryService(
      cfg(),
      llm(
        JSON.stringify({
          entidades: [{ nome: 'Duda', tipo: 'pessoa', apelidos: ['esposa'] }],
          relacoes: [{ de: 'Duda', rel: 'esposa_de', para: 'Jean' }],
        }),
      ),
    );
    await m.learn([userMsg('a Duda, minha esposa, mandou um beijo')]);
    expect(m.all()).toHaveLength(1);
    expect(m.summaries()).toEqual(['Duda — esposa de Jean']);

    // Citada pelo apelido, cai na mesma entidade em vez de criar outra.
    m.note('Esposa', 'pessoa');
    expect(m.all()).toHaveLength(1);
    expect(m.all()[0]!.mentions).toBe(2);
  });

  it('ligação de valor único substitui o valor antigo', async () => {
    const c = cfg();
    const resp = (valor: string) => JSON.stringify({ entidades: [{ nome: 'jogo do macaco', tipo: 'projeto' }], relacoes: [{ de: 'jogo do macaco', rel: 'status', valor }] });
    await new MemoryService(c, llm(resp('em andamento'))).learn([userMsg('tô fazendo o jogo do macaco')]);
    const m = new MemoryService(c, llm(resp('pausado')));
    await m.learn([userMsg('parei o jogo do macaco')]);
    expect(m.summaries()).toEqual(['jogo do macaco — status: pausado']);
    expect(m.grafo().relacoes).toHaveLength(1);
  });

  it('summaries com foco traz a entidade citada e as vizinhas antes das recentes', async () => {
    const m = new MemoryService(
      cfg(),
      llm(
        JSON.stringify({
          entidades: [
            { nome: 'Duda', tipo: 'pessoa' },
            { nome: 'curso de confeitaria', tipo: 'hobby' },
          ],
          relacoes: [{ de: 'Duda', rel: 'faz', para: 'curso de confeitaria' }],
        }),
      ),
    );
    await m.learn([userMsg('a Duda começou um curso de confeitaria')]);
    for (let i = 0; i < 5; i++) m.note(`assunto recente ${i}`);
    const out = m.summaries(2, 'hoje falei com a duda');
    expect(out).toEqual(['Duda — faz curso de confeitaria', 'curso de confeitaria']);
  });

  it('esquecer leva junto as ligações da entidade', async () => {
    const m = new MemoryService(
      cfg(),
      llm(JSON.stringify({ entidades: [{ nome: 'Duda', tipo: 'pessoa' }, { nome: 'Floripa', tipo: 'lugar' }], relacoes: [{ de: 'Duda', rel: 'mora_em', para: 'Floripa' }] })),
    );
    await m.learn([userMsg('a Duda mora em Floripa')]);
    expect(m.esquecer('Floripa')).toEqual(['Floripa']);
    expect(m.grafo().relacoes).toEqual([]);
    expect(m.summaries()).toEqual(['Duda']);
  });

  it('pessoa sem ligação nenhuma não volta como assunto antigo', () => {
    const m = new MemoryService(cfg(), llm(''));
    m.note('Carlos', 'pessoa');
    m.all()[0]!.lastSeenAt = Date.now() - 10 * 24 * 3600_000;
    expect(m.stale(4)).toBeNull();
  });

  it('migra o lembrancas.json antigo para o grafo', () => {
    const c = cfg();
    const antigo = [{ id: 'a1', texto: 'novo emprego', createdAt: 1, lastSeenAt: 2, mentions: 3 }];
    writeFileSync(join(c.DATA_DIR, 'lembrancas.json'), JSON.stringify(antigo));
    const m = new MemoryService(c, llm(''));
    expect(m.all()).toEqual([{ ...antigo[0], tipo: 'outro', apelidos: [] }]);
    const salvo = JSON.parse(readFileSync(join(c.DATA_DIR, 'memoria-grafo.json'), 'utf8')) as { entidades: unknown[] };
    expect(salvo.entidades).toHaveLength(1);
  });

  it('ficha traz as ligações nos dois sentidos', async () => {
    const m = new MemoryService(
      cfg(),
      llm(JSON.stringify({ entidades: [{ nome: 'Duda', tipo: 'pessoa' }, { nome: 'confeitaria', tipo: 'hobby' }, { nome: 'Floripa', tipo: 'lugar' }], relacoes: [{ de: 'Duda', rel: 'esposa_de', para: 'Jean' }, { de: 'Duda', rel: 'faz', para: 'confeitaria' }, { de: 'Floripa', rel: 'cidade_de', para: 'Duda' }] })),
    );
    await m.learn([userMsg('a Duda de Floripa faz confeitaria')]);
    const duda = m.all().find((e) => e.texto === 'Duda')!;
    expect(m.ficha(duda)).toBe('Duda — esposa de Jean; faz confeitaria; Floripa — cidade de Duda');
  });

  it('curiosidades só traz o que tem ligação e não apareceu nos últimos dias', async () => {
    const m = new MemoryService(
      cfg(),
      llm(JSON.stringify({ entidades: [{ nome: 'Duda', tipo: 'pessoa' }, { nome: 'confeitaria', tipo: 'hobby' }, { nome: 'Eduardo', tipo: 'pessoa' }], relacoes: [{ de: 'Duda', rel: 'faz', para: 'confeitaria' }] })),
    );
    await m.learn([userMsg('a Duda faz confeitaria; o Eduardo deu oi')]);
    expect(m.curiosidades(2, 2)).toEqual([]); // tudo visto agora há pouco
    for (const e of m.all()) e.lastSeenAt = Date.now() - 5 * 24 * 3600_000;
    const nomes = m.curiosidades(5, 2).map((e) => e.texto);
    expect(nomes.sort()).toEqual(['Duda', 'confeitaria']); // Eduardo é nome solto, sem ligação
    const duda = m.all().find((e) => e.texto === 'Duda')!;
    expect(m.curiosidades(5, 2, duda.id).map((e) => e.texto)).toEqual(['confeitaria']);
  });

  describe('arrumar()', () => {
    it('corrige tipo e nome, junta repetidas e o dono, apaga e liga', async () => {
      const c = cfg();
      const resp = JSON.stringify({
        corrigir: [
          { id: 'e1', tipo: 'pessoa' },
          { id: 'e3', tipo: 'trabalho' },
          { id: 'e6', tipo: 'lugar' },
        ],
        juntar: [
          { id: 'e2', em: 'dono' },
          { id: 'e5', em: 'e3' },
        ],
        apagar: ['e4'],
        relacoes: [
          { de: 'e1', rel: 'trabalha_em', para: 'e3' },
          { de: 'dono', rel: 'mora_em', para: 'e6' },
          { de: 'e9', rel: 'inventado', para: 'e1' },
        ],
      });
      // Como as lembranças antigas chegaram: tudo "outro", o dono como outra entidade, frase, repetida.
      const m = new MemoryService(c, llm(resp));
      for (const n of ['Kleiton', 'Jean', 'TaxResearch', 'cálculo retornando zero no relatório', 'Tax Research', 'Rio Preto']) m.note(n);
      m.touch(m.all()[0]!.id); // grava o arquivo
      expect(await m.arrumar([userMsg('o Kleiton é da TaxResearch')])).toBe(true);

      const nomes = m.all().map((e) => `${e.texto}:${e.tipo}`);
      expect(nomes).toEqual(['Kleiton:pessoa', 'TaxResearch:trabalho', 'Rio Preto:lugar']);
      expect(m.all()[1]!.apelidos).toContain('Tax Research');
      expect(m.all()[1]!.mentions).toBe(2);
      expect(m.ficha(m.all()[0]!)).toBe('Kleiton — trabalha em TaxResearch');
      expect(m.grafo().relacoes).toHaveLength(2);
      expect(m.arrumado()).toBe(true);
      expect(readFileSync(join(c.DATA_DIR, 'memoria-grafo.antes-da-arrumacao.json'), 'utf8')).toContain('cálculo retornando zero');
      // Só uma vez: recarregando, continua arrumada.
      expect(await new MemoryService(c, llm(resp)).arrumar([])).toBe(false);
    });

    it('troca frase por nome curto, guardando a frase como apelido', async () => {
      const c = cfg();
      const m = new MemoryService(c, llm('{"corrigir":[{"id":"e1","nome":"auto process COMPESA","tipo":"projeto"}]}'));
      m.note('ajuste no auto process da COMPESA');
      await m.arrumar([]);
      expect(m.all()[0]).toMatchObject({ texto: 'auto process COMPESA', tipo: 'projeto', apelidos: ['ajuste no auto process da COMPESA'] });
    });

    it('resposta sem JSON não marca como arrumada', async () => {
      const m = new MemoryService(cfg(), llm('não sei'));
      m.note('Kleiton');
      expect(await m.arrumar([])).toBe(false);
      expect(m.arrumado()).toBe(false);
      expect(m.all()).toHaveLength(1);
    });
  });

  it('learn() não guarda o dono como entidade solta', async () => {
    const m = new MemoryService(cfg(), llm('{"entidades":[{"nome":"Jean","tipo":"pessoa"},{"nome":"Duda","tipo":"pessoa"}]}'));
    await m.learn([userMsg('a Duda é minha esposa')]);
    expect(m.all().map((e) => e.texto)).toEqual(['Duda']);
  });
});
