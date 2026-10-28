import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChatMessage } from '@robo/protocol';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import { LlmService } from '../llm/llm.service.js';

export interface Anotacao {
  dia: string; // YYYY-MM-DD, no fuso do dono
  texto: string;
}

const GUARDA = 7; // dias
const MAX_MSGS = 60;

/**
 * O diário do robô: no dia seguinte ele anota, em poucas frases, como foi o dia do dono — o que fez,
 * como parecia, o que ficou no ar. É o que dá continuidade ("ontem você tava brigando com o deploy").
 */
@Injectable()
export class DiarioService {
  private readonly log = new Logger(DiarioService.name);
  private readonly file: string;
  private readonly diaFmt: Intl.DateTimeFormat;
  private anotacoes: Anotacao[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly llm: LlmService,
  ) {
    this.file = rootPath(`${cfg.DATA_DIR}/diario.json`);
    this.diaFmt = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.TZ_NAME, year: 'numeric', month: '2-digit', day: '2-digit' });
    try {
      this.anotacoes = JSON.parse(readFileSync(this.file, 'utf8')) as Anotacao[];
    } catch {
      /* primeira vez */
    }
  }

  dia(ts: number): string {
    return this.diaFmt.format(ts);
  }

  tem(dia: string): boolean {
    return this.anotacoes.some((a) => a.dia === dia);
  }

  /** As anotações de ontem e anteontem, para o prompt ("ontem (ter 27/10): ..."). */
  recentes(now = new Date()): string[] {
    const fmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: this.cfg.TZ_NAME });
    const dias = [1, 2].map((n) => this.dia(now.getTime() - n * 24 * 3600_000));
    return dias.flatMap((d, i) => {
      const a = this.anotacoes.find((x) => x.dia === d);
      if (!a) return [];
      const nome = fmt.format(new Date(`${d}T12:00:00Z`)).replace(/\.,?/g, '');
      return [`${i === 0 ? `ontem (${nome})` : nome}: ${a.texto}`];
    });
  }

  /** Escreve a anotação do `dia` a partir da conversa dele. Sem conversa do dono, não há o que anotar. */
  async escrever(dia: string, conversa: ChatMessage[]): Promise<void> {
    if (!this.llm.enabled || this.tem(dia)) return;
    const msgs = conversa.filter((m) => this.dia(m.ts) === dia);
    if (!msgs.some((m) => m.from === 'user')) return;
    const owner = this.cfg.OWNER_NAME || 'o dono';
    const linhas = msgs
      .slice(-MAX_MSGS)
      .map((m) => {
        const quem = m.from === 'user' ? owner : m.kind === 'codigo' ? 'Robô (olhando o código dele)' : m.kind === 'whatsapp' ? 'Robô (recado do WhatsApp)' : 'Robô';
        return `${quem}: ${m.text.replace(/\s+/g, ' ').slice(0, m.from === 'user' ? 300 : 160)}`;
      })
      .join('\n');
    try {
      const msg = await this.llm.complete(
        [
          {
            role: 'system',
            content:
              `Você é o robô que fica na mesa de ${owner} e mantém um diário pessoal. Escreva a anotação do dia ` +
              `abaixo: 2 a 4 frases, em primeira pessoa, informal, sobre o dia DELE — no que ele trabalhou, o que ` +
              'aconteceu, como ele parecia (corrido, de boa, estressado), o que ficou no ar e o que você quer ' +
              'perguntar depois. Só o que está na conversa: não invente. Sem listas, sem markdown, sem data.',
          },
          { role: 'user', content: linhas },
        ],
        undefined,
        { maxTokens: 300, temperature: 0.5 },
      );
      const texto = (msg.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\s+/g, ' ').trim().slice(0, 600);
      if (!texto) return;
      this.anotacoes = [...this.anotacoes.filter((a) => a.dia !== dia), { dia, texto }].sort((a, b) => a.dia.localeCompare(b.dia)).slice(-GUARDA);
      this.save();
      this.log.log(`Diário de ${dia}: ${texto}`);
    } catch (err) {
      this.log.warn(`escrever(${dia}) falhou: ${(err as Error).message}`);
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.anotacoes));
    } catch (err) {
      this.log.warn(`Falha ao salvar diário: ${(err as Error).message}`);
    }
  }
}
