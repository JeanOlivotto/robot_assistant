import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { ChatMessage } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import { LlmService } from '../llm/llm.service.js';

export interface Memoria {
  id: string;
  texto: string; // o nome do assunto ("Duda", "jogo do macaco")
  createdAt: number;
  lastSeenAt: number; // última vez que apareceu na conversa ou que o robô citou
  mentions: number;
}

const TIPOS = ['pessoa', 'projeto', 'lugar', 'saude', 'meta', 'hobby', 'trabalho', 'outro'] as const;
export type Tipo = (typeof TIPOS)[number];

/** Um nó do grafo: pessoa, projeto, lugar... O dono não é guardado — é o nó fixo `DONO`. */
export interface Entidade extends Memoria {
  tipo: Tipo;
  apelidos: string[]; // outros jeitos de chamar ("esposa", "Maria Eduarda")
}

/** Uma ligação: entre duas entidades (`para`) ou de uma entidade com um atributo livre (`valor`). */
export interface Relacao {
  id: string;
  de: string;
  rel: string; // "esposa_de", "trabalha_em", "status"
  para?: string;
  valor?: string;
  lastSeenAt: number;
}

interface Grafo {
  entidades: Entidade[];
  relacoes: Relacao[];
  /** Quando passou pela arrumação única (as lembranças antigas viraram entidades soltas, sem tipo). */
  arrumadoEm?: number;
}

const DONO = 'dono';
const MAX = 300; // só a vizinhança do assunto vai para o prompt, então dá para lembrar bem mais
/** Relações que só têm um valor por vez: um status novo substitui o antigo. */
const UNICAS = new Set(['status', 'mora_em', 'cargo', 'idade', 'aniversario']);
/** Palavras que não identificam assunto nenhum ("o projeto do jogo" → "jogo"). */
const VAZIAS = new Set(['que', 'dos', 'das', 'com', 'para', 'pra', 'meu', 'minha', 'esse', 'essa', 'isso', 'aquele', 'aquela', 'projeto', 'assunto']);

const NORMALIZE = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const Nome = z.string().trim().min(2).max(80);
const EntidadeLlm = z.object({
  nome: Nome,
  tipo: z.enum(TIPOS).catch('outro'),
  apelidos: z.array(Nome).catch([]).default([]),
});
const RelacaoLlm = z.object({
  de: Nome,
  rel: z.string().trim().min(2).max(40),
  para: Nome.optional().catch(undefined),
  valor: z.string().trim().min(1).max(80).optional().catch(undefined),
});

const Ref = z.string().trim().min(1).max(12); // "e3" ou "dono"
const ArrumacaoLlm = z.object({
  corrigir: z.array(z.object({ id: Ref, nome: Nome.optional().catch(undefined), tipo: z.enum(TIPOS).optional().catch(undefined), apelidos: z.array(Nome).catch([]).default([]) })).catch([]).default([]),
  juntar: z.array(z.object({ id: Ref, em: Ref })).catch([]).default([]),
  apagar: z.array(Ref).catch([]).default([]),
  relacoes: z.array(z.object({ de: Ref, rel: z.string().trim().min(2).max(40), para: Ref.optional().catch(undefined), valor: z.string().trim().min(1).max(80).optional().catch(undefined) })).catch([]).default([]),
});

/** Só os itens que passam no schema — um item torto do LLM não derruba o resto. */
const itens = <T>(v: unknown, schema: z.ZodType<T>, max: number): T[] =>
  Array.isArray(v)
    ? v
        .map((x) => schema.safeParse(x))
        .filter((r) => r.success)
        .map((r) => r.data as T)
        .slice(0, max)
    : [];

/**
 * Memória de longo prazo em grafo: os assuntos importantes do dono (pessoas, projetos, saúde, metas) e
 * como eles se ligam ("Duda — esposa de Jean"). O robô guarda por semanas, cita de vez em quando —
 * "faz tempo que não falamos disso" — e no prompt entra só a vizinhança do que está sendo conversado.
 */
@Injectable()
export class MemoryService {
  private readonly log = new Logger(MemoryService.name);
  private readonly file: string;
  private items: Entidade[] = [];
  private relacoes: Relacao[] = [];
  private arrumadoEm = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly llm: LlmService,
  ) {
    this.file = rootPath(`${cfg.DATA_DIR}/memoria-grafo.json`);
    this.load(rootPath(`${cfg.DATA_DIR}/lembrancas.json`));
  }

  all(): Entidade[] {
    return this.items;
  }

  grafo(): Grafo {
    return { entidades: this.items, relacoes: this.relacoes };
  }

  /** A ficha de uma lembrança com as ligações dela ("Duda — esposa de Jean; faz curso de confeitaria"). */
  ficha(e: Entidade): string {
    const extras = this.vizinhas(e.id)
      .filter((v) => !this.relacoes.some((r) => r.de === e.id && r.para === v.id))
      .map((v) => this.descrever(v));
    return [this.descrever(e), ...extras].join('; ');
  }

  /** Como o nó fixo do dono (id "dono") aparece. */
  nomeDoDono(): string {
    return this.cfg.OWNER_NAME || 'o dono';
  }

  /**
   * Frases curtas para o robô saber do que se lembra (entram no prompt). Com `foco` (o que o dono
   * acabou de falar), vêm primeiro as entidades citadas e as vizinhas delas; o resto completa com as mais recentes.
   */
  summaries(limit = 12, foco?: string): string[] {
    const recentes = [...this.items].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    const escolhidas = new Map<string, Entidade>();
    if (foco) {
      const citadas = this.citadas(foco);
      for (const e of citadas) escolhidas.set(e.id, e);
      for (const e of citadas) for (const v of this.vizinhas(e.id)) escolhidas.set(v.id, v);
    }
    for (const e of recentes) escolhidas.set(e.id, e);
    return [...escolhidas.values()].slice(0, limit).map((e) => this.descrever(e));
  }

  /** Um assunto que não aparece há um tempo, para o robô puxar de volta. */
  stale(minDays: number): Entidade | null {
    const cutoff = Date.now() - minDays * 24 * 3600_000;
    // Uma pessoa sem ligação nenhuma é só um nome solto — não vale um "faz tempo que...".
    const vale = (e: Entidade) => e.tipo !== 'pessoa' || this.relacoes.some((r) => r.de === e.id || r.para === e.id);
    const old = this.items.filter((e) => e.lastSeenAt < cutoff && vale(e)).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    return old[0] ?? null;
  }

  /**
   * Coisas da vida do dono para o robô ter curiosidade ("e o curso da Duda, já fez o bolo?"): só o que tem
   * alguma ligação — um nome solto daria um "lembra do Eduardo? como ficou aquilo?" vazio — e que não
   * apareceu nos últimos `minDias`. Sorteia pesando pelas menções, para variar o assunto de um dia pro outro.
   */
  curiosidades(n = 2, minDias = 2, excluir?: string, sorteio: () => number = Math.random): Entidade[] {
    const cutoff = Date.now() - minDias * 24 * 3600_000;
    const ligadas = new Set(this.relacoes.flatMap((r) => [r.de, r.para ?? '']));
    const pool = this.items.filter((e) => e.id !== excluir && e.lastSeenAt < cutoff && ligadas.has(e.id));
    const out: Entidade[] = [];
    while (out.length < n && pool.length) {
      const total = pool.reduce((t, e) => t + e.mentions, 0);
      let alvo = sorteio() * total;
      const i = Math.max(0, pool.findIndex((e) => (alvo -= e.mentions) < 0));
      out.push(pool.splice(i, 1)[0]!);
    }
    return out;
  }

  /** Marca que um assunto voltou à tona agora (o robô citou, ou o dono falou dele). */
  touch(id: string): void {
    const e = this.items.find((x) => x.id === id);
    if (!e) return;
    const agora = Date.now();
    e.lastSeenAt = agora;
    e.mentions += 1;
    for (const r of this.relacoes) if (r.de === id || r.para === id) r.lastSeenAt = agora;
    this.save();
  }

  /** Esquece tudo o que sabia do dono. */
  clear(): number {
    const had = this.items.length;
    this.items = [];
    this.relacoes = [];
    this.save();
    this.log.log(`Memória apagada (${had} assunto(s))`);
    return had;
  }

  /**
   * Apaga as lembranças que batem com o assunto ("jogo do macaco" leva "Projeto jogo macaco" e
   * "Desenvolver jogo macaco") e as ligações delas. Bate quando todas as palavras que importam do
   * assunto estão no nome ou num apelido.
   */
  esquecer(assunto: string): string[] {
    const palavras = NORMALIZE(assunto)
      .split(' ')
      .filter((w) => w.length > 2 && !VAZIAS.has(w));
    if (!palavras.length) return [];
    const bate = (e: Entidade) =>
      [e.texto, ...e.apelidos].some((n) => {
        const t = ` ${NORMALIZE(n)} `;
        return palavras.every((w) => t.includes(` ${w}`));
      });
    const foram = this.items.filter(bate);
    if (!foram.length) return [];
    this.remover(new Set(foram.map((e) => e.id)));
    this.save();
    this.log.log(`Esqueceu: ${foram.map((e) => e.texto).join('; ')}`);
    return foram.map((e) => e.texto);
  }

  note(texto: string, tipo: Tipo = 'outro', apelidos: string[] = []): Entidade | null {
    const clean = texto.trim().slice(0, 120);
    if (!clean) return null;
    const agora = Date.now();
    const existing = this.achar(clean);
    if (existing) {
      existing.lastSeenAt = agora;
      existing.mentions += 1;
      if (existing.tipo === 'outro') existing.tipo = tipo;
      this.apelidar(existing, apelidos);
      return existing;
    }
    const nova: Entidade = { id: randomUUID(), texto: clean, tipo, apelidos: [], createdAt: agora, lastSeenAt: agora, mentions: 1 };
    this.apelidar(nova, apelidos);
    this.items.push(nova);
    return nova;
  }

  /** Lê a conversa recente e guarda as entidades e ligações duradouras que valem a pena lembrar. */
  async learn(history: ChatMessage[]): Promise<void> {
    if (!this.llm.enabled || history.length === 0) return;
    const texto = history
      .slice(-12)
      .map((m) => `${m.from === 'user' ? 'Dono' : 'Robô'}: ${m.text}${m.photo?.desc ? ` [mandou foto: ${m.photo.desc}]` : ''}`)
      .join('\n');
    const jaSabe =
      [...this.items]
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(0, 150)
        .map((e) => `- ${e.texto} (${e.tipo}${e.apelidos.length ? `; ${e.apelidos.join(', ')}` : ''})`)
        .join('\n') || '(nada ainda)';
    try {
      const msg = await this.llm.complete(
        [
          {
            role: 'system',
            content:
              'Você cuida da memória de longo prazo de um robô sobre o dono dele, guardada como um grafo de ' +
              'entidades e ligações. Da conversa, extraia o que vale lembrar por semanas: projetos de verdade, ' +
              'trabalho, saúde, pessoas importantes e quem elas são, metas, viagens, hobbies, decisões pessoais.\n' +
              'NÃO inclua: compromissos de agenda; pendências e tarefas (o robô já guarda à parte); pedidos para o ' +
              'robô fazer algo no computador; páginas, jogos e projetos que o robô criou só para testar ou mostrar; ' +
              'testes do próprio robô; saudações ou trivialidades. Na dúvida, não guarde.\n' +
              `Tipos: ${TIPOS.join(', ')}. O dono é a entidade "dono" — não a liste em "entidades".\n` +
              'Se a entidade já está guardada, use EXATAMENTE o mesmo nome; outro jeito de chamá-la vai em "apelidos".\n' +
              'Ligações: "rel" em snake_case curto (esposa_de, trabalha_em, cliente_de, parte_de). Entre duas ' +
              'entidades use "para"; para um atributo use "valor" (rel "status" com valor "pausado").\n' +
              'Se o dono disse que algo JÁ GUARDADO era só teste, não importa mais ou acabou, ponha o nome ' +
              'exato em "esquecer".\n' +
              'Responda SOMENTE com JSON {"entidades": [{"nome","tipo","apelidos"}], "relacoes": [{"de","rel",' +
              '"para"|"valor"}], "esquecer": string[]}, nomes curtos (1 a 5 palavras). Sem nada, ' +
              '{"entidades": [], "relacoes": [], "esquecer": []}.',
          },
          { role: 'user', content: `Já guardado:\n${jaSabe}\n\nConversa:\n${texto}` },
        ],
        undefined,
        { maxTokens: 900, temperature: 0.2 },
      );
      this.aplicar(this.parse(msg.content ?? ''));
      this.trim();
      this.save();
    } catch (err) {
      this.log.warn(`learn() falhou: ${(err as Error).message}`);
    }
  }

  /** Já passou pela arrumação única (ou não tem nada para arrumar). */
  arrumado(): boolean {
    return this.arrumadoEm > 0 || this.items.length === 0;
  }

  /**
   * Arrumação única da memória: as lembranças antigas viraram entidades soltas, sem tipo e sem ligação
   * (e às vezes frases inteiras, ou o próprio dono como outra pessoa). O LLM revê tudo de uma vez, com a
   * conversa como contexto: corrige nome e tipo, junta repetidas, apaga o que não serve e liga o que der.
   * Guarda uma cópia do grafo antes (memoria-grafo.antes-da-arrumacao.json).
   */
  async arrumar(history: ChatMessage[]): Promise<boolean> {
    if (!this.llm.enabled || this.arrumado()) return false;
    const ref = new Map(this.items.map((e, i) => [`e${i + 1}`, e.id]));
    const refDe = new Map([...ref].map(([r, id]) => [id, r]));
    refDe.set(DONO, DONO);
    const lista = [...ref]
      .map(([r, id]) => {
        const e = this.items.find((x) => x.id === id)!;
        return `${r}: ${e.texto} (${e.tipo}${e.apelidos.length ? `; ${e.apelidos.join(', ')}` : ''}; ${e.mentions}x)`;
      })
      .join('\n');
    const ligacoes =
      this.relacoes
        .map((r) => `${refDe.get(r.de)} ${r.rel} ${r.para ? refDe.get(r.para) : `= ${r.valor}`}`)
        .join('\n') || '(nenhuma)';
    // A conversa dá o contexto de quem é quem; cabe no limite por minuto.
    let conversa = '';
    for (const m of [...history].reverse()) {
      const linha = `${m.from === 'user' ? 'Dono' : 'Robô'}: ${m.text.slice(0, 300)}\n`;
      if (conversa.length + linha.length > 8_000) break;
      conversa = linha + conversa;
    }
    try {
      const msg = await this.llm.complete(
        [
          {
            role: 'system',
            content:
              `Você arruma a memória de longo prazo de um robô sobre o dono dele (${this.nomeDoDono()}, a entidade "dono"). ` +
              'A memória é um grafo, mas muita coisa entrou bagunçada: tudo como "outro", sem ligações, às vezes uma frase ' +
              'em vez de um nome, às vezes repetida ou o próprio dono como se fosse outra pessoa.\n' +
              `Tipos: ${TIPOS.join(', ')}. Use a conversa para saber quem é quem; não invente o que ela não mostra.\n` +
              '- "corrigir": tipo certo de cada entidade e, se o nome for uma frase, um nome curto (1 a 5 palavras) do assunto.\n' +
              '- "juntar": entidades que são a mesma coisa ("em" é a que fica; o dono é "dono").\n' +
              '- "apagar": o que não vale lembrar por semanas (tarefa pontual, teste do robô, trivialidade).\n' +
              '- "relacoes": ligações que a conversa mostra, "rel" em snake_case curto (trabalha_em, colega_de, cliente_de, ' +
              'parte_de, mora_em); entre duas entidades use "para", para um atributo use "valor".\n' +
              'Use só os ids da lista (e1, e2...) ou "dono". Responda SOMENTE com JSON {"corrigir": [{"id","nome"?,"tipo",' +
              '"apelidos"?}], "juntar": [{"id","em"}], "apagar": [id], "relacoes": [{"de","rel","para"|"valor"}]}.',
          },
          { role: 'user', content: `Entidades:\n${lista}\n\nLigações:\n${ligacoes}\n\nConversa:\n${conversa || '(vazia)'}` },
        ],
        undefined,
        // Sem pressa: começa pela reserva para não comer a cota diária do Groq.
        { maxTokens: 4000, temperature: 0.2, reservaPrimeiro: true },
      );
      const out = this.parseArrumacao(msg.content ?? '');
      if (!out) {
        this.log.warn('arrumar(): resposta sem JSON — tenta de novo amanhã');
        return false;
      }
      if (existsSync(this.file)) copyFileSync(this.file, this.file.replace(/\.json$/, '.antes-da-arrumacao.json'));
      const antes = { entidades: this.items.length, relacoes: this.relacoes.length };
      this.aplicarArrumacao(out, ref);
      this.arrumadoEm = Date.now();
      this.save();
      this.log.log(
        `Memória arrumada: ${antes.entidades} → ${this.items.length} entidade(s), ${antes.relacoes} → ${this.relacoes.length} ligação(ões)`,
      );
      return true;
    } catch (err) {
      this.log.warn(`arrumar() falhou: ${(err as Error).message}`);
      return false;
    }
  }

  private parseArrumacao(raw: string): z.infer<typeof ArrumacaoLlm> | null {
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '');
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const r = ArrumacaoLlm.safeParse(JSON.parse(clean.slice(start, end + 1)));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  }

  private aplicarArrumacao(out: z.infer<typeof ArrumacaoLlm>, ref: Map<string, string>): void {
    const id = (r: string) => (r === DONO ? DONO : ref.get(r));
    const ent = (i: string | undefined) => (i ? this.items.find((e) => e.id === i) : undefined);
    for (const c of out.corrigir) {
      const e = ent(id(c.id));
      if (!e) continue;
      if (c.tipo) e.tipo = c.tipo;
      if (c.nome && NORMALIZE(c.nome) !== NORMALIZE(e.texto)) {
        const antigo = e.texto;
        e.texto = c.nome.slice(0, 120);
        e.apelidos = e.apelidos.filter((a) => NORMALIZE(a) !== NORMALIZE(e.texto));
        this.apelidar(e, [antigo]);
      }
      this.apelidar(e, c.apelidos);
    }
    for (const j of out.juntar) {
      const sai = ent(id(j.id));
      const fica = id(j.em);
      if (!sai || !fica || fica === sai.id || (fica !== DONO && !ent(fica))) continue;
      const alvo = ent(fica);
      if (alvo) {
        alvo.mentions += sai.mentions;
        alvo.lastSeenAt = Math.max(alvo.lastSeenAt, sai.lastSeenAt);
        alvo.createdAt = Math.min(alvo.createdAt, sai.createdAt);
        this.apelidar(alvo, [sai.texto, ...sai.apelidos]);
      }
      for (const r of this.relacoes) {
        if (r.de === sai.id) r.de = fica;
        if (r.para === sai.id) r.para = fica;
      }
      this.relacoes = this.relacoes.filter((r) => r.de !== r.para);
      this.items = this.items.filter((e) => e !== sai);
    }
    this.remover(new Set(out.apagar.map(id).filter((i): i is string => !!i && i !== DONO)));
    // As ligações passam pelo mesmo caminho do learn(), pelo nome — mas só entre quem está na lista.
    const nome = (r: string | undefined) => {
      const i = r ? id(r) : undefined;
      return i === DONO ? DONO : ent(i)?.texto;
    };
    const relacoes = out.relacoes.flatMap((r) => {
      const de = nome(r.de);
      const para = r.para ? nome(r.para) : undefined;
      if (!de || (r.para && !para)) return [];
      return [{ de, rel: r.rel, ...(para ? { para } : { valor: r.valor }) }];
    });
    this.aplicar({ entidades: [], relacoes, esquecer: [] });
  }

  private aplicar(out: ReturnType<MemoryService['parse']>): void {
    if (out.esquecer.length) {
      const fora = new Set(out.esquecer.map((n) => this.achar(n)?.id).filter((id): id is string => !!id));
      this.remover(fora);
    }
    // O dono é o nó fixo: "Jean" na lista viraria um segundo Jean solto no mapa.
    for (const e of out.entidades) if (!this.ehDono(e.nome)) this.note(e.nome, e.tipo, e.apelidos);
    const agora = Date.now();
    for (const r of out.relacoes) {
      const de = this.idDe(r.de);
      const para = r.para ? this.idDe(r.para) : undefined;
      const valor = para ? undefined : r.valor;
      if (!de || (!para && !valor) || de === para) continue;
      const rel = NORMALIZE(r.rel.replace(/[_-]/g, ' ')).replace(/ /g, '_');
      const igual = this.relacoes.find((x) => x.de === de && x.rel === rel && x.para === para && NORMALIZE(x.valor ?? '') === NORMALIZE(valor ?? ''));
      if (igual) {
        igual.lastSeenAt = agora;
        continue;
      }
      if (UNICAS.has(rel)) this.relacoes = this.relacoes.filter((x) => !(x.de === de && x.rel === rel));
      this.relacoes.push({ id: randomUUID(), de, rel, ...(para ? { para } : { valor }), lastSeenAt: agora });
    }
  }

  private parse(raw: string) {
    const nada = { entidades: [] as z.infer<typeof EntidadeLlm>[], relacoes: [] as z.infer<typeof RelacaoLlm>[], esquecer: [] as string[] };
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '');
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) return nada;
    try {
      const obj = JSON.parse(clean.slice(start, end + 1)) as Record<string, unknown>;
      // "assuntos" é o formato antigo (lista de frases); se o modelo voltar a ele, vira entidade solta.
      const antigos = itens(obj.assuntos, Nome, 8).map((nome) => ({ nome, tipo: 'outro' as const, apelidos: [] }));
      return {
        entidades: [...itens(obj.entidades, EntidadeLlm, 12), ...antigos],
        relacoes: itens(obj.relacoes, RelacaoLlm, 16),
        esquecer: itens(obj.esquecer, Nome, 8),
      };
    } catch {
      return nada;
    }
  }

  /** A entidade com esse nome ou apelido (comparação normalizada). */
  private achar(nome: string): Entidade | undefined {
    const key = NORMALIZE(nome);
    if (!key) return undefined;
    return this.items.find((e) => NORMALIZE(e.texto) === key || e.apelidos.some((a) => NORMALIZE(a) === key));
  }

  /** Id de uma ponta de ligação: o dono, uma entidade conhecida ou uma nova (tipo "outro"). */
  private idDe(nome: string): string | undefined {
    if (this.ehDono(nome)) return DONO;
    return (this.achar(nome) ?? this.note(nome))?.id;
  }

  private ehDono(nome: string): boolean {
    const key = NORMALIZE(nome);
    const dono = NORMALIZE(this.cfg.OWNER_NAME ?? '');
    return key === DONO || key === 'eu' || (!!dono && key === dono);
  }

  private apelidar(e: Entidade, apelidos: string[]): void {
    for (const a of apelidos) {
      const key = NORMALIZE(a);
      if (key && key !== NORMALIZE(e.texto) && !e.apelidos.some((x) => NORMALIZE(x) === key)) e.apelidos.push(a.trim());
    }
    e.apelidos = e.apelidos.slice(0, 6);
  }

  private citadas(foco: string): Entidade[] {
    const texto = ` ${NORMALIZE(foco)} `;
    return this.items.filter((e) =>
      [e.texto, ...e.apelidos].some((n) => {
        const key = NORMALIZE(n);
        return key.length > 2 && texto.includes(` ${key} `);
      }),
    );
  }

  private vizinhas(id: string): Entidade[] {
    const ids = new Set<string>();
    for (const r of this.relacoes) {
      if (r.de === id && r.para) ids.add(r.para);
      if (r.para === id) ids.add(r.de);
    }
    return this.items.filter((e) => ids.has(e.id));
  }

  /** "Duda — esposa de Jean; aniversario: maio". Sem ligações, só o nome. */
  private descrever(e: Entidade): string {
    const nome = (id: string) => (id === DONO ? this.nomeDoDono() : this.items.find((x) => x.id === id)?.texto);
    const partes = this.relacoes
      .filter((r) => r.de === e.id)
      .map((r) => {
        const rel = r.rel.replace(/_/g, ' ');
        if (r.valor) return `${rel}: ${r.valor}`;
        const alvo = r.para ? nome(r.para) : undefined;
        return alvo ? `${rel} ${alvo}` : '';
      })
      .filter(Boolean);
    return partes.length ? `${e.texto} — ${partes.join('; ')}` : e.texto;
  }

  /** Tira as entidades e todas as ligações que tocam nelas. */
  private remover(ids: Set<string>): void {
    if (!ids.size) return;
    this.items = this.items.filter((e) => !ids.has(e.id));
    this.relacoes = this.relacoes.filter((r) => !ids.has(r.de) && !(r.para && ids.has(r.para)));
  }

  private trim(): void {
    if (this.items.length <= MAX) return;
    this.items.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    this.remover(new Set(this.items.slice(MAX).map((e) => e.id)));
  }

  /** Carrega o grafo; na primeira vez, migra a lista antiga (lembrancas.json) como entidades soltas. */
  private load(antigo: string): void {
    try {
      const g = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Grafo>;
      this.items = g.entidades ?? [];
      this.relacoes = g.relacoes ?? [];
      this.arrumadoEm = g.arrumadoEm ?? 0;
      return;
    } catch {
      /* grafo ainda não existe */
    }
    if (!existsSync(antigo)) return;
    try {
      const velhas = JSON.parse(readFileSync(antigo, 'utf8')) as Memoria[];
      this.items = velhas.map((m) => ({ ...m, tipo: 'outro', apelidos: [] }));
      this.save();
      this.log.log(`Migrou ${this.items.length} lembrança(s) de lembrancas.json para o grafo`);
    } catch (err) {
      this.log.warn(`Falha ao migrar lembranças antigas: ${(err as Error).message}`);
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ entidades: this.items, relacoes: this.relacoes, arrumadoEm: this.arrumadoEm || undefined } satisfies Grafo));
    } catch (err) {
      this.log.warn(`Falha ao salvar memória: ${(err as Error).message}`);
    }
  }
}
