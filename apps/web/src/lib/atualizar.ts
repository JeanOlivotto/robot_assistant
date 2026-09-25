/**
 * Versão nova no ar: a página se recarrega sozinha. No app do computador a bolha e o painel ficam
 * abertos dias sem recarregar — e seguiam com o código antigo (ex.: respondendo em todos os
 * aparelhos depois que isso foi corrigido). O servidor manda a versão no snapshot; mudou, recarrega
 * assim que der: sem reunião gravando, fora de ligação e com você sem mexer há um tempo.
 */
const GRAVANDO_KEY = 'robo.gravando'; // o mesmo do Meeting.tsx
const PARADO_MS = 20_000;

let primeira: string | null = null;
let pendente = false;
let mexeuEm = Date.now();
/** A ligação (modo chamada) liga isto enquanto está aberta. */
export const ocupado = { chamada: false };

function gravando(): boolean {
  try {
    return !!localStorage.getItem(GRAVANDO_KEY);
  } catch {
    return false;
  }
}

function tentar(): void {
  if (!pendente || ocupado.chamada || gravando()) return;
  if (document.visibilityState === 'visible' && Date.now() - mexeuEm < PARADO_MS) return;
  location.reload();
}

/** Chamado a cada snapshot do servidor (reconectar depois de um deploy traz a versão nova). */
export function versaoDoServidor(rev: string | undefined): void {
  if (!rev || rev === 'dev') return;
  if (primeira === null) {
    primeira = rev;
    return;
  }
  if (rev === primeira || pendente) return;
  pendente = true;
  for (const ev of ['pointerdown', 'keydown', 'pointermove']) addEventListener(ev, () => (mexeuEm = Date.now()), { passive: true });
  setInterval(tentar, 5000);
  tentar();
}
