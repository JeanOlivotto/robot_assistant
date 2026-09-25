/**
 * De onde sai o pedido: um id por aparelho (guardado no app — no computador, a bolha e o painel
 * dividem o mesmo) e, no app do computador, o nome da máquina. A resposta volta marcada com o id:
 * só quem perguntou abre balão e fala; no computador, a ação roda nele mesmo.
 */
import { desktop } from './desktop';

const KEY = 'miro.origem';

let id: string | null = null;

export function minhaOrigem(): string {
  if (id) return id;
  try {
    id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
  } catch {
    id ??= crypto.randomUUID(); // sem armazenamento: vale enquanto a página estiver aberta
  }
  return id;
}

let maquina: string | undefined | null = null;

/** O nome deste computador (só no app do computador). */
export function minhaMaquina(): string | undefined {
  if (maquina === null) maquina = desktop?.maquina?.() || undefined;
  return maquina;
}

/** Os campos para o `say`/`confirm` do WebSocket. */
export function deOnde(): { origem: string; maquina?: string } {
  const m = minhaMaquina();
  return { origem: minhaOrigem(), ...(m ? { maquina: m } : {}) };
}

/** Os mesmos, como cabeçalhos (áudio vai por HTTP). */
export function cabecalhosDeOnde(): Record<string, string> {
  const m = minhaMaquina();
  return { 'X-Miro-Origem': minhaOrigem(), ...(m ? { 'X-Miro-Maquina': encodeURIComponent(m) } : {}) };
}

/** A mensagem é para este aparelho reagir (balão, voz)? Sem destino, é para todos. */
export function eParaMim(m: { para?: string }): boolean {
  return !m.para || m.para === minhaOrigem();
}
