import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import { LlmService } from '../llm/llm.service.js';
import { PushService } from '../push/push.service.js';
import { SttError, SttService } from '../stt/stt.service.js';

/** Uma ação/pendência da reunião; responsável quando dá para identificar. */
export interface AtaAcao {
  texto: string;
  responsavel?: string;
}
export interface Ata {
  resumo: string;
  decisoes: string[];
  acoes: AtaAcao[];
}
export interface Meeting {
  id: string;
  titulo: string;
  startedAt: number;
  endedAt?: number;
  segments: number;
  transcript: string;
  seconds: number;
  ata?: Ata;
}

/** Quanto do transcript mandamos ao LLM (o modelo tem contexto grande; isto é só um teto de segurança). */
const TRANSCRIPT_LIMIT = 200_000;

/**
 * Modo reunião: grava em pedaços pelo app, transcreve cada um (Groq) e, ao parar,
 * o LLM monta a ata (resumo, decisões, ações). Avisa "Ata pronta" no celular.
 */
@Injectable()
export class MeetingService {
  private readonly log = new Logger(MeetingService.name);
  private readonly dir: string;
  private readonly active = new Map<string, Meeting>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly stt: SttService,
    private readonly llm: LlmService,
    private readonly push: PushService,
  ) {
    this.dir = rootPath(`${cfg.DATA_DIR}/meetings`);
  }

  get ready(): boolean {
    return this.stt.enabled && this.llm.enabled;
  }

  start(titulo?: string): Meeting {
    const m: Meeting = {
      id: randomUUID(),
      titulo: (titulo ?? '').trim() || 'Reunião',
      startedAt: Date.now(),
      segments: 0,
      transcript: '',
      seconds: 0,
    };
    this.active.set(m.id, m);
    this.log.log(`Reunião iniciada (${m.id})`);
    return m;
  }

  async addSegment(id: string, audio: Buffer): Promise<{ seconds: number; chars: number }> {
    const m = this.active.get(id) ?? this.load(id);
    if (!m) throw new MeetingError('reunião não encontrada', 404);
    if (m.endedAt) throw new MeetingError('reunião já encerrada', 409);
    // Trecho em silêncio é normal numa reunião: não derruba a gravação, só não acrescenta nada.
    let text = '';
    let seconds = 0;
    try {
      ({ text, seconds } = await this.stt.transcribe(audio));
    } catch (err) {
      if (!(err instanceof SttError && err.status === 422)) throw err;
    }
    if (text) {
      m.transcript = m.transcript ? `${m.transcript} ${text}` : text;
      m.segments += 1;
      m.seconds += seconds;
      this.active.set(m.id, m);
    }
    return { seconds: m.seconds, chars: m.transcript.length };
  }

  async stop(id: string): Promise<Meeting> {
    const m = this.active.get(id) ?? this.load(id);
    if (!m) throw new MeetingError('reunião não encontrada', 404);
    m.endedAt = Date.now();
    if (!m.transcript.trim()) {
      m.ata = { resumo: 'A reunião não teve fala suficiente para uma ata.', decisoes: [], acoes: [] };
    } else {
      m.ata = await this.buildAta(m);
    }
    this.save(m);
    this.active.delete(m.id);
    this.log.log(`Ata pronta (${m.id}): ${m.ata.decisoes.length} decisão(ões), ${m.ata.acoes.length} ação(ões)`);
    void this.push.notify({
      title: 'Ata pronta',
      body: `${m.titulo}: ${m.ata.decisoes.length} decisão(ões) e ${m.ata.acoes.length} ação(ões).`,
      tag: `ata-${m.id}`,
      url: '/',
    });
    return m;
  }

  get(id: string): Meeting | null {
    return this.active.get(id) ?? this.load(id);
  }

  /** Reuniões já encerradas, mais recentes primeiro. */
  list(): Meeting[] {
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
      .filter((m): m is Meeting => m !== null)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  private async buildAta(m: Meeting): Promise<Ata> {
    const transcript = m.transcript.slice(0, TRANSCRIPT_LIMIT);
    const system =
      'Você é um secretário que escreve a ata de uma reunião a partir da transcrição (português do Brasil). ' +
      'Responda SOMENTE com JSON válido, sem cercas de código, neste formato: ' +
      '{"resumo": string, "decisoes": string[], "acoes": [{"texto": string, "responsavel"?: string}]}. ' +
      'resumo: 2 a 5 frases dos pontos principais. decisoes: o que ficou decidido (frases curtas; [] se nada claro). ' +
      'acoes: tarefas/pendências, cada uma com "responsavel" só se a pessoa for citada. Não invente nada que não esteja na transcrição.';
    const msg = await this.llm.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: `Transcrição da reunião:\n\n${transcript}` },
      ],
      undefined,
      { maxTokens: 1500, temperature: 0.3 },
    );
    return this.parseAta(msg.content ?? '');
  }

  /** O modelo às vezes envolve o JSON em texto/cercas; extrai o objeto e valida os campos. */
  private parseAta(raw: string): Ata {
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const obj = JSON.parse(clean.slice(start, end + 1)) as Partial<Ata>;
        return {
          resumo: typeof obj.resumo === 'string' ? obj.resumo.trim() : clean.slice(0, 600),
          decisoes: Array.isArray(obj.decisoes) ? obj.decisoes.filter((d): d is string => typeof d === 'string') : [],
          acoes: Array.isArray(obj.acoes)
            ? obj.acoes
                .map((a) => (a && typeof (a as AtaAcao).texto === 'string' ? (a as AtaAcao) : null))
                .filter((a): a is AtaAcao => a !== null)
                .map((a) => ({ texto: a.texto.trim(), ...(a.responsavel ? { responsavel: String(a.responsavel).trim() } : {}) }))
            : [],
        };
      } catch {
        /* cai no fallback */
      }
    }
    // Sem JSON utilizável: guarda o texto como resumo para não perder o trabalho.
    return { resumo: clean.slice(0, 1500), decisoes: [], acoes: [] };
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
