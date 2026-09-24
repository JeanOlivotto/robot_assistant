import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ChatService } from '../chat/chat.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import { LlmService } from '../llm/llm.service.js';
import { TaskService } from '../tasks/task.service.js';
import { SttError, SttService, type TranscriptSegment } from '../stt/stt.service.js';
import { BancoVozesService } from '../vozes/banco.service.js';
import { VozesService, type Turno } from '../vozes/vozes.service.js';

/** Uma tarefa da reunião; responsável e prazo quando dá para identificar. */
export interface AtaAcao {
  texto: string;
  responsavel?: string;
  prazo?: string;
}
export interface Ata {
  resumo: string;
  /** Os assuntos que importaram, além do que foi decidido. */
  pontos?: string[];
  decisoes: string[];
  acoes: AtaAcao[];
}
/** Um trecho contínuo de uma pessoa só — a "reunião completa", separada por voz. */
export interface Fala {
  pessoa: number;
  inicio: number;
  fim: number;
  texto: string;
}
/** Quem é cada "Pessoa N" da reunião: reconhecida pelo banco de vozes, ou esperando um nome. */
export interface VozReuniao {
  pessoa: number;
  nome?: string;
  /** Semelhança com a voz do banco, quando reconheceu. */
  score?: number;
  /** A assinatura fica na reunião: é ela que vai para o banco quando você disser quem é. */
  embedding?: number[];
}
export interface Meeting {
  id: string;
  titulo: string;
  startedAt: number;
  endedAt?: number;
  /** gravando → processando (vozes + ata) → pronta. Atas antigas não têm o campo: estão prontas. */
  status?: 'gravando' | 'processando' | 'pronta';
  segments: number;
  transcript: string;
  seconds: number;
  /** Trechos de áudio recebidos, inclusive os em silêncio (contam no relógio da reunião). */
  trechos?: number;
  /** Frases com horário, por trecho de áudio — casam com "quem falou quando". */
  partes?: { i: number; frases: TranscriptSegment[] }[];
  falas?: Fala[];
  pessoas?: number;
  vozes?: VozReuniao[];
  ata?: Ata;
}

/** Quanto do transcript mandamos ao LLM (o modelo tem contexto grande; isto é só um teto de segurança). */
const TRANSCRIPT_LIMIT = 200_000;
/* O gpt-oss raciocina antes de escrever e isso conta no limite: com 1500 a ata de reunião longa saía cortada. */
const ATA_MAX_TOKENS = 8000;
const SAMPLE_RATE = 16000;

/**
 * Modo reunião: grava em pedaços pelo app, transcreve cada um (Groq) e guarda o áudio. Ao encerrar,
 * o serviço de vozes separa quem falou quando, o LLM monta a ata, e o robô avisa no chat — nos dois
 * momentos: quando a reunião acaba e quando a ata fica pronta. O áudio é apagado no fim.
 */
@Injectable()
export class MeetingService implements OnModuleInit {
  private readonly log = new Logger(MeetingService.name);
  private readonly dir: string;
  private readonly active = new Map<string, Meeting>();
  /** Atas sendo montadas agora (a separação de vozes de 1 h leva minutos). */
  private readonly working = new Map<string, Promise<Meeting>>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly stt: SttService,
    private readonly llm: LlmService,
    private readonly tasks: TaskService,
    private readonly vozes: VozesService,
    private readonly chat: ChatService,
    private readonly banco: BancoVozesService,
  ) {
    this.dir = rootPath(`${cfg.DATA_DIR}/meetings`);
  }

  /** O servidor reiniciou (deploy) no meio de uma ata: retoma de onde parou. */
  onModuleInit(): void {
    for (const m of this.all()) {
      if (m.status === 'processando') {
        this.log.log(`Retomando a ata de "${m.titulo}" (${m.id})`);
        this.process(m);
      }
    }
  }

  get ready(): boolean {
    return this.stt.enabled && this.llm.enabled;
  }

  start(titulo?: string): Meeting {
    const m: Meeting = {
      id: randomUUID(),
      titulo: (titulo ?? '').trim() || 'Reunião',
      startedAt: Date.now(),
      status: 'gravando',
      segments: 0,
      transcript: '',
      seconds: 0,
      trechos: 0,
      partes: [],
    };
    this.active.set(m.id, m);
    this.save(m);
    this.log.log(`Reunião iniciada (${m.id})`);
    return m;
  }

  async addSegment(id: string, audio: Buffer): Promise<{ seconds: number; chars: number }> {
    const m = this.active.get(id) ?? this.load(id);
    if (!m) throw new MeetingError('reunião não encontrada', 404);
    if (m.endedAt) throw new MeetingError('reunião já encerrada', 409);

    // O áudio fica até a ata sair: é dele que o serviço de vozes tira quem falou quando.
    const i = m.trechos ?? 0;
    m.trechos = i + 1;
    this.saveAudio(m.id, i, audio);

    // Trecho em silêncio é normal numa reunião: não derruba a gravação, só não acrescenta texto.
    try {
      const { text, seconds, segments } = await this.stt.transcribe(audio, { dica: false }); // reunião tem muito silêncio
      if (text) {
        m.transcript = m.transcript ? `${m.transcript} ${text}` : text;
        m.segments += 1;
        m.seconds += seconds;
        (m.partes ??= []).push({ i, frases: segments?.length ? segments : [{ start: 0, end: seconds, text }] });
      }
    } catch (err) {
      if (!(err instanceof SttError && err.status === 422)) throw err;
    }
    this.active.set(m.id, m);
    // Grava a cada trecho: um deploy no meio da reunião não pode levar a transcrição junto.
    this.save(m);
    return { seconds: m.seconds, chars: m.transcript.length };
  }

  /**
   * Encerra na hora e monta a ata em segundo plano (separar as vozes de uma reunião longa leva
   * minutos — o app não fica esperando). O robô avisa no chat quando a ata ficar pronta.
   */
  finish(id: string): Meeting {
    const m = this.active.get(id) ?? this.load(id);
    if (!m) throw new MeetingError('reunião não encontrada', 404);
    // Clicou duas vezes, ou o app tentou de novo: não refaz a ata nem cria pendência repetida.
    if (m.endedAt && (m.ata || this.working.has(m.id))) return m;
    m.endedAt ??= Date.now();
    m.status = 'processando';
    this.active.delete(m.id);
    this.save(m);
    const min = Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000));
    this.chat.robotSay(
      `Reunião "${m.titulo}" encerrada (${min} min). Estou montando a ata — te aviso quando ficar pronta.`,
      'thinking',
      'meeting',
    );
    this.process(m);
    return m;
  }

  /** Encerra e espera a ata ficar pronta. */
  async stop(id: string): Promise<Meeting> {
    const m = this.finish(id);
    return this.working.get(m.id) ?? m;
  }

  get(id: string): Meeting | null {
    return this.active.get(id) ?? this.load(id);
  }

  /** Reuniões encerradas (prontas ou com a ata saindo), mais recentes primeiro. */
  list(): Meeting[] {
    return this.all()
      .filter((m) => !!m.endedAt)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  private all(): Meeting[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Meeting;
        } catch {
          return null;
        }
      })
      .filter((m): m is Meeting => m !== null);
  }

  private process(m: Meeting): void {
    if (this.working.has(m.id)) return;
    const job = this.buildEverything(m).finally(() => this.working.delete(m.id));
    this.working.set(m.id, job);
  }

  private async buildEverything(m: Meeting): Promise<Meeting> {
    if (m.transcript.trim()) {
      const falas = await this.falasComVozes(m).catch((err: Error) => {
        this.log.warn(`Não deu para separar as vozes (${m.id}): ${err.message}`);
        return null;
      });
      if (falas?.length) {
        m.falas = falas;
        m.pessoas = new Set(falas.map((f) => f.pessoa)).size;
      }
      try {
        m.ata = await this.buildAta(m);
      } catch (err) {
        // A transcrição fica guardada mesmo sem ata — perder a reunião inteira por causa do LLM não dá.
        this.log.error(`Falha ao gerar a ata (${m.id}): ${(err as Error).message}`);
        m.ata = { resumo: `Não consegui gerar a ata agora (${(err as Error).message}). A transcrição ficou guardada.`, decisoes: [], acoes: [] };
      }
    } else {
      m.ata = { resumo: 'A reunião não teve fala suficiente para uma ata.', decisoes: [], acoes: [] };
    }
    m.status = 'pronta';
    this.save(m);
    this.dropAudio(m.id);

    // As tarefas da ata viram pendências: é o que o robô vai cobrar depois.
    for (const a of m.ata.acoes) this.tasks.add(a.texto, { pessoa: a.responsavel, origem: 'ata', meetingId: m.id });
    const ata = m.ata;
    const partes = [
      ata.decisoes.length ? `${ata.decisoes.length} decisão(ões)` : '',
      ata.acoes.length ? `${ata.acoes.length} tarefa(s)` : '',
      m.pessoas ? `${m.pessoas} voz(es)` : '',
    ].filter(Boolean);
    const conhecidas = (m.vozes ?? []).filter((v) => v.nome).map((v) => v.nome!);
    const semNome = (m.vozes ?? []).filter((v) => !v.nome && v.embedding).length;
    this.chat.robotSay(
      `A ata de "${m.titulo}" ficou pronta${partes.length ? ` — ${partes.join(', ')}` : ''}.` +
        (conhecidas.length ? ` Reconheci ${conhecidas.join(', ')}.` : '') +
        (semNome
          ? ` ${semNome === 1 ? 'Uma voz eu não conheço' : `${semNome} vozes eu não conheço`} — me diga quem é na ata, na aba Reunião.`
          : ' Está na aba Reunião.'),
      'happy',
      'meeting',
    );
    this.log.log(`Ata pronta (${m.id}): ${ata.decisoes.length} decisão(ões), ${ata.acoes.length} ação(ões), ${m.pessoas ?? 0} voz(es)`);
    return m;
  }

  /**
   * Casa a transcrição com os turnos de fala: o áudio de todos os trechos vira um só, o serviço
   * de vozes diz quem falou quando, e cada frase vai para quem mais falou naquele intervalo.
   */
  private async falasComVozes(m: Meeting): Promise<Fala[] | null> {
    if (!this.vozes.enabled || !m.partes?.length || !m.trechos) return null;
    const pcms: Buffer[] = [];
    const offset: number[] = [];
    let total = 0;
    for (let i = 0; i < m.trechos; i++) {
      offset[i] = total / (SAMPLE_RATE * 2);
      const audio = this.loadAudio(m.id, i);
      if (!audio) continue;
      const pcm = await this.stt.toPcm(audio).catch(() => Buffer.alloc(0));
      pcms.push(pcm);
      total += pcm.length;
    }
    if (!total) return null;
    const r = await this.vozes.diarizar(Buffer.concat(pcms, total));
    if (!r?.turnos.length) return null;

    // Banco de vozes: quem já foi apresentado sai com o nome; os outros esperam você dizer quem é.
    m.vozes = [];
    for (let p = 1; p <= r.pessoas; p++) {
      const a = (r.assinaturas ?? []).find((x) => x.pessoa === p);
      const quem = a ? this.banco.identificar(a.embedding) : null;
      if (quem?.certeza === 'alta') this.banco.reforcar(quem, a!.embedding);
      m.vozes.push({
        pessoa: p,
        ...(quem?.certeza === 'alta' ? { nome: quem.nome, score: quem.score } : {}),
        ...(a ? { embedding: a.embedding } : {}),
      });
    }

    const falas: Fala[] = [];
    for (const parte of m.partes) {
      for (const f of parte.frases) {
        const inicio = offset[parte.i]! + f.start;
        const fim = offset[parte.i]! + f.end;
        const pessoa = quemFalou(r.turnos, inicio, fim);
        const ultima = falas.at(-1);
        if (ultima && ultima.pessoa === pessoa && inicio - ultima.fim < 3) {
          ultima.texto = `${ultima.texto} ${f.text}`;
          ultima.fim = fim;
        } else {
          falas.push({ pessoa, inicio: +inicio.toFixed(1), fim: +fim.toFixed(1), texto: f.text });
        }
      }
    }
    return falas;
  }

  private async buildAta(m: Meeting): Promise<Ata> {
    const comVozes = !!m.falas?.length;
    const transcript = (comVozes ? m.falas!.map((f) => `${this.rotulo(m, f.pessoa)}: ${f.texto}`).join('\n') : m.transcript).slice(
      0,
      TRANSCRIPT_LIMIT,
    );
    const system =
      'Você é um secretário que escreve a ata de uma reunião a partir da transcrição (português do Brasil). ' +
      'Responda SOMENTE com JSON válido, sem cercas de código, neste formato: ' +
      '{"resumo": string, "pontos": string[], "decisoes": string[], "acoes": [{"texto": string, "responsavel"?: string, "prazo"?: string}]}. ' +
      'resumo: 3 a 6 frases contando o que a reunião foi, o que se discutiu e onde chegou — quem não estava deve entender. ' +
      'pontos: os assuntos e informações importantes que apareceram (números, problemas, riscos, contexto), frases curtas. ' +
      'decisoes: só o que ficou DECIDIDO ([] se nada claro). ' +
      'acoes: as tarefas combinadas — "responsavel" só se der para saber quem, "prazo" só se for dito (ex.: "sexta", "até dia 30"). ' +
      (comVozes
        ? 'A transcrição vem separada por voz: pelo nome, quando a voz foi reconhecida, ou "Pessoa N" quando não. ' +
          'Se uma "Pessoa N" for chamada pelo nome e der para saber quem é, use o nome; senão, mantenha "Pessoa N" ' +
          'exatamente assim. A separação por voz pode errar em trechos curtos — prefira o sentido da conversa quando os dois brigarem. '
        : '') +
      'Não invente nada que não esteja na transcrição.';
    const msg = await this.llm.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: `Transcrição da reunião:\n\n${transcript}` },
      ],
      undefined,
      { maxTokens: ATA_MAX_TOKENS, temperature: 0.3 },
    );
    return this.parseAta(msg.content ?? '');
  }

  /** O modelo às vezes envolve o JSON em texto/cercas; extrai o objeto e valida os campos. */
  private parseAta(raw: string): Ata {
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string' && !!d.trim()) : []);
    if (start >= 0 && end > start) {
      try {
        const obj = JSON.parse(clean.slice(start, end + 1)) as Partial<Ata>;
        return {
          resumo: typeof obj.resumo === 'string' ? obj.resumo.trim() : clean.slice(0, 600),
          pontos: strings(obj.pontos),
          decisoes: strings(obj.decisoes),
          acoes: Array.isArray(obj.acoes)
            ? obj.acoes
                .map((a) => (a && typeof (a as AtaAcao).texto === 'string' ? (a as AtaAcao) : null))
                .filter((a): a is AtaAcao => a !== null)
                .map((a) => ({
                  texto: a.texto.trim(),
                  ...(a.responsavel ? { responsavel: String(a.responsavel).trim() } : {}),
                  ...(a.prazo ? { prazo: String(a.prazo).trim() } : {}),
                }))
            : [],
        };
      } catch {
        /* cai no fallback */
      }
    }
    // Sem JSON utilizável: guarda o texto como resumo para não perder o trabalho.
    return { resumo: clean.slice(0, 1500), decisoes: [], acoes: [] };
  }

  /** "Jean" se a voz foi reconhecida (ou nomeada), senão "Pessoa N". */
  private rotulo(m: Meeting, pessoa: number): string {
    return m.vozes?.find((v) => v.pessoa === pessoa)?.nome ?? `Pessoa ${pessoa}`;
  }

  /**
   * Você disse quem é a "Pessoa N": a voz entra no banco (reconhecida nas próximas reuniões e no
   * chat) e a ata troca "Pessoa N" pelo nome.
   */
  nomearVoz(id: string, pessoa: number, nome: string): Meeting {
    const m = this.load(id);
    if (!m) throw new MeetingError('reunião não encontrada', 404);
    const v = m.vozes?.find((x) => x.pessoa === pessoa);
    if (!v) throw new MeetingError(`não tem Pessoa ${pessoa} nesta reunião`, 404);
    const limpo = nome.trim().slice(0, 40);
    if (!limpo) throw new MeetingError('falta o nome', 400);
    if (v.embedding) this.banco.cadastrar(limpo, v.embedding);
    v.nome = limpo;

    const troca = (s: string) => s.replace(new RegExp(`\\bPessoa ${pessoa}\\b`, 'g'), limpo);
    if (m.ata) {
      m.ata = {
        resumo: troca(m.ata.resumo),
        pontos: m.ata.pontos?.map(troca),
        decisoes: m.ata.decisoes.map(troca),
        acoes: m.ata.acoes.map((a) => ({ ...a, texto: troca(a.texto), ...(a.responsavel ? { responsavel: troca(a.responsavel) } : {}) })),
      };
    }
    this.save(m);
    this.log.log(`Pessoa ${pessoa} de "${m.titulo}" é ${limpo}`);
    return m;
  }

  /** Joga a reunião fora de vez: some da lista e o arquivo vai junto (e o áudio, se ainda houver). */
  remove(id: string): boolean {
    const m = this.active.get(id) ?? this.load(id);
    if (!m) return false;
    this.active.delete(id);
    this.dropAudio(id);
    try {
      rmSync(join(this.dir, `${safeId(id)}.json`));
    } catch (err) {
      this.log.warn(`Não consegui apagar a ata ${id}: ${(err as Error).message}`);
      return false;
    }
    this.log.log(`Reunião apagada: ${m.titulo}`);
    return true;
  }

  private audioDir(id: string): string {
    return join(this.dir, `${safeId(id)}.audio`);
  }

  private saveAudio(id: string, i: number, audio: Buffer): void {
    try {
      mkdirSync(this.audioDir(id), { recursive: true });
      writeFileSync(join(this.audioDir(id), `${String(i).padStart(4, '0')}.bin`), audio);
    } catch (err) {
      this.log.warn(`Não guardei o áudio do trecho ${i}: ${(err as Error).message}`);
    }
  }

  private loadAudio(id: string, i: number): Buffer | null {
    try {
      return readFileSync(join(this.audioDir(id), `${String(i).padStart(4, '0')}.bin`));
    } catch {
      return null;
    }
  }

  private dropAudio(id: string): void {
    rmSync(this.audioDir(id), { recursive: true, force: true });
  }

  private load(id: string): Meeting | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, `${safeId(id)}.json`), 'utf8')) as Meeting;
    } catch {
      return null;
    }
  }

  private save(m: Meeting): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${safeId(m.id)}.json`), JSON.stringify(m));
    } catch (err) {
      this.log.error(`Falha ao salvar a ata: ${(err as Error).message}`);
    }
  }
}

/** Quem mais falou dentro de [inicio, fim]; sem sobreposição nenhuma, o turno mais próximo. */
export function quemFalou(turnos: Turno[], inicio: number, fim: number): number {
  let melhor = 0;
  let sobra = 0;
  for (const t of turnos) {
    const o = Math.min(fim, t.fim) - Math.max(inicio, t.inicio);
    if (o > sobra) {
      sobra = o;
      melhor = t.pessoa;
    }
  }
  if (melhor) return melhor;
  const meio = (inicio + fim) / 2;
  let perto = Infinity;
  for (const t of turnos) {
    const d = meio < t.inicio ? t.inicio - meio : meio > t.fim ? meio - t.fim : 0;
    if (d < perto) {
      perto = d;
      melhor = t.pessoa;
    }
  }
  return melhor;
}

export class MeetingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Só UUID nosso vira nome de arquivo — nada de path traversal. */
function safeId(id: string): string {
  return /^[0-9a-f-]{36}$/i.test(id) ? id : '';
}
