import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Face } from '@robo/protocol';
import { ChatService } from '../chat/chat.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { SilencioService } from '../proactive/silencio.service.js';
import { RobotStateService } from '../robot/robot-state.service.js';
import { RecadosAppsService } from './recados-apps.service.js';
import { RecadosStore, type NovoRecado, type Recado } from './recados.store.js';

const TICK_MS = 60_000;
/** Recado normal só no horário em que ele pode puxar conversa (o mesmo do proativo). */
const HORARIO = { from: 8, to: 21 };
/** Por aplicação, por minuto: acima disso a aplicação está em loop e leva 429. */
const MAX_POR_MINUTO = 60;
/** Falhas seguidas da sonda antes de avisar (uma solta é ruído). */
const FALHAS_PARA_AVISAR = 3;
const CHAVE_VIGIA = 'vigia:health';
const TIMEOUT_SONDA_MS = 10_000;
const SONDA_MS = 2 * 60_000;

/** Como a última sonda do /health encontrou a aplicação. */
export interface EstadoSaude {
  ok: boolean;
  em: number;
  erro?: string;
}

const ICONE: Record<Recado['tipo'], string> = { suporte: '💬', saude: '🩺', cadastro: '🆕', outro: '📨' };

/**
 * Recados das aplicações do dono (suporte, saúde, cadastro…) chegando no robô. Quem decide QUANDO
 * contar é o código, não o modelo: urgente vai na hora (fura a folga), normal respeita horário e
 * silêncio, baixa só no bom-dia ou quando ele perguntar. Atualizações do mesmo recado se juntam.
 */
@Injectable()
export class RecadosService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RecadosService.name);
  private readonly hora: Intl.DateTimeFormat;
  private timer?: NodeJS.Timeout;
  private vigiaTimer?: NodeJS.Timeout;
  private readonly falhas = new Map<string, number>();
  private readonly saude = new Map<string, EstadoSaude>();
  private readonly ritmo = new Map<string, number[]>();

  constructor(
    @Inject(APP_CONFIG) cfg: AppConfig,
    private readonly store: RecadosStore,
    private readonly chat: ChatService,
    private readonly robot: RobotStateService,
    private readonly silencio: SilencioService,
    private readonly apps: RecadosAppsService,
  ) {
    this.hora = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: cfg.TZ_NAME });
  }

  onModuleInit(): void {
    const apps = this.apps.listar();
    this.log.log(apps.length ? `Recados: ${apps.map((a) => `${a.nome}${a.ativo ? '' : ' (desativada)'}`).join(', ')}` : 'Recados: nenhuma aplicação cadastrada ainda');
    // O tick entrega o que ficou guardado: silêncio que acabou, atualização que esperou a janela.
    this.timer = setInterval(() => this.entregar(), TICK_MS);
    // A lista de vigiadas é lida a cada rodada: aplicação nova no app entra sem reiniciar.
    this.vigiaTimer = setInterval(() => void this.vigiar(), SONDA_MS);
    setTimeout(() => void this.vigiar(), 15_000);
  }

  /** O que a última sonda viu (null = sem sonda ainda, ou sem URL de saúde). */
  estadoSaude(app: string): EstadoSaude | null {
    return this.saude.get(app) ?? null;
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    clearInterval(this.vigiaTimer);
  }

  /** false = a aplicação passou do limite por minuto. */
  dentroDoRitmo(app: string, now = Date.now()): boolean {
    const recentes = (this.ritmo.get(app) ?? []).filter((t) => now - t < 60_000);
    if (recentes.length >= MAX_POR_MINUTO) {
      this.ritmo.set(app, recentes);
      return false;
    }
    recentes.push(now);
    this.ritmo.set(app, recentes);
    return true;
  }

  receber(app: string, r: NovoRecado): { id: string | null; novo: boolean; aberto: boolean } {
    const { recado, novo } = this.store.receber(app, r);
    if (!r.chave?.startsWith('vigia:')) this.apps.registrarRecado(app);
    if (recado) this.log.log(`Recado de ${app} (${recado.tipo}/${recado.prioridade}${r.resolvido ? ', resolvido' : ''}): ${recado.titulo}`);
    this.entregar();
    return { id: recado?.id ?? null, novo, aberto: recado?.aberto ?? false };
  }

  /** Conta ao dono o que tem novidade e pode ser dito agora. Um recado por vez vira uma mensagem; vários, uma lista. */
  entregar(now = Date.now()): void {
    const podeNormal = this.podeNormal(now);
    const novos = this.store.paraAvisar(now, podeNormal);
    const fechados = this.store.fechamentosParaAvisar(podeNormal);
    if (!novos.length && !fechados.length) return;

    const linhas = [...novos.map((r) => this.linha(r)), ...fechados.map((r) => `✅ ${r.app}: ${r.titulo} — resolvido.`)];
    const urgente = novos.some((r) => r.prioridade === 'urgente');
    const texto = linhas.length === 1 ? linhas[0]! : `📨 ${linhas.length} recados dos sistemas:\n\n${linhas.join('\n\n')}`;
    const face: Face = urgente ? 'worried' : novos.length ? 'neutral' : 'happy';
    this.chat.robotSay(texto, face, 'recado');
    if (urgente) {
      const r = novos.find((x) => x.prioridade === 'urgente')!;
      this.robot.say(`${r.app}: ${r.titulo}`, 15_000);
    }
    this.store.marcarAvisados([...novos, ...fechados], now);
  }

  /** "🚨 baixaxml · saude: Fora do ar (3x)\n"trecho"\nlink". */
  private linha(r: Recado): string {
    const icone = r.prioridade === 'urgente' ? '🚨' : ICONE[r.tipo];
    const vezes = r.vezes > 1 ? ` (${r.vezes}x)` : '';
    const trecho = r.texto ? `\n“${r.texto.length > 280 ? `${r.texto.slice(0, 277)}…` : r.texto}”` : '';
    return `${icone} ${r.app} · ${r.tipo}: ${r.titulo}${vezes}${trecho}${r.link ? `\n${r.link}` : ''}`;
  }

  private podeNormal(now: number): boolean {
    const h = Number(this.hora.format(now));
    return h >= HORARIO.from && h < HORARIO.to && !this.silencio.motivo(new Date(now));
  }

  /**
   * A aplicação fora do ar não manda recado nenhum: por isso o robô também bate no /health dela.
   * N falhas seguidas abrem um recado urgente; a primeira resposta boa fecha.
   */
  async vigiar(): Promise<void> {
    await Promise.all(
      this.apps.vigiadas().map(async ({ app, url }) => {
        const erro = await sondar(url);
        this.saude.set(app, { ok: !erro, em: Date.now(), ...(erro ? { erro } : {}) });
        if (!erro) {
          this.falhas.set(app, 0);
          if (this.store.temAberto(app, CHAVE_VIGIA)) {
            this.receber(app, { tipo: 'saude', prioridade: 'urgente', texto: 'Voltou a responder.', chave: CHAVE_VIGIA, resolvido: true });
          }
          return;
        }
        const n = (this.falhas.get(app) ?? 0) + 1;
        this.falhas.set(app, n);
        this.log.warn(`Sonda de ${app} falhou (${n}x): ${erro}`);
        if (n === FALHAS_PARA_AVISAR) {
          this.receber(app, {
            tipo: 'saude',
            prioridade: 'urgente',
            titulo: 'Fora do ar',
            texto: `${url} não responde há uns ${(n * SONDA_MS) / 60_000} min (${erro}).`,
            chave: CHAVE_VIGIA,
            resolvido: false,
          });
        }
      }),
    );
  }
}

/** null = respondeu 2xx. */
async function sondar(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_SONDA_MS), redirect: 'follow' });
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    return e.name === 'TimeoutError' ? 'sem resposta em 10 s' : (e.cause?.code ?? e.message);
  }
}
