import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ChatVoz } from '@robo/protocol';

const VALE_MS = 2 * 60_000;

/**
 * "Miro, …" no computador: o servidor confirma o nome e já descobre de quem é a voz, mas quem
 * manda o comando para a conversa é a bolha (ela resolve antes os comandos locais, como gravar
 * reunião). O `ref` liga uma coisa à outra: o say chega com ele e entra como FALA, com a voz de
 * quem falou — antes entrava como texto digitado, e ele obedecia qualquer voz sem perguntar.
 */
@Injectable()
export class ChamadosService {
  private readonly guardados = new Map<string, { voz?: ChatVoz; em: number }>();

  guardar(voz: ChatVoz | undefined): string {
    const agora = Date.now();
    for (const [k, v] of this.guardados) if (agora - v.em > VALE_MS) this.guardados.delete(k);
    const ref = randomUUID();
    this.guardados.set(ref, { voz, em: agora });
    return ref;
  }

  /** Usa uma vez: devolve a voz daquele chamado (null se não existe ou venceu). */
  retirar(ref: string | undefined): { voz?: ChatVoz } | null {
    if (!ref) return null;
    const g = this.guardados.get(ref);
    this.guardados.delete(ref);
    if (!g || Date.now() - g.em > VALE_MS) return null;
    return { voz: g.voz };
  }
}
