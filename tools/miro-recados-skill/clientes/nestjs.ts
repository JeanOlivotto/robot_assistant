/**
 * Recados do Miro — cliente NestJS/Node (Node 18+, usa o fetch nativo).
 *
 * Adapte ao projeto: se ele usa ConfigService, leia as variáveis por ele; registre no módulo
 * certo (ou num módulo global pequeno) e injete onde o evento acontece.
 */
import { Injectable, Logger } from '@nestjs/common';

export type TipoRecado = 'suporte' | 'saude' | 'cadastro' | 'outro';
export type PrioridadeRecado = 'urgente' | 'normal' | 'baixa';

export interface Recado {
  titulo: string;
  texto?: string;
  tipo?: TipoRecado;
  prioridade?: PrioridadeRecado;
  link?: string;
  /** Mesma chave atualiza o recado aberto ("suporte:123"). */
  chave?: string;
}

const TIMEOUT_MS = 5_000;

@Injectable()
export class MiroRecadosService {
  private readonly logger = new Logger(MiroRecadosService.name);
  private readonly url = (process.env.MIRO_RECADOS_URL ?? '').replace(/\/+$/, '');
  private readonly chave = process.env.MIRO_RECADOS_CHAVE ?? '';

  get ligado(): boolean {
    return !!(this.url && this.chave);
  }

  /** Fire-and-forget: nunca lança, nunca segura quem chamou. */
  recado(r: Recado): void {
    if (!this.ligado) return;
    void this.enviar({
      ...r,
      titulo: r.titulo.slice(0, 120),
      ...(r.texto ? { texto: r.texto.slice(0, 2000) } : {}),
    });
  }

  /** Fecha o recado aberto com esta chave (o chamado foi resolvido, a fonte voltou). */
  resolvido(chave: string, texto?: string): void {
    if (!this.ligado) return;
    void this.enviar({ chave, resolvido: true, ...(texto ? { texto: texto.slice(0, 2000) } : {}) });
  }

  private async enviar(corpo: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(`${this.url}/api/recados`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.chave}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) this.logger.warn(`Miro recusou o recado (HTTP ${res.status})`);
    } catch (err) {
      this.logger.warn(`Recado ao Miro não enviado: ${(err as Error).message}`);
    }
  }
}

/*
 * Uso (ao lado do e-mail que já sai para os admins):
 *
 *   this.miro.recado({
 *     tipo: 'suporte',
 *     titulo: `Chamado novo: ${conversa.assunto}`,
 *     texto: `${conversa.user.nome}: ${texto}`,
 *     link: `${urlPublica()}/admin/suporte?c=${conversaId}`,
 *     chave: `suporte:${conversaId}`,
 *   });
 *
 *   // chamado fechado
 *   this.miro.resolvido(`suporte:${conversaId}`);
 */
