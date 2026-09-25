/**
 * De onde veio o pedido que chega por HTTP (áudio, foto): o app manda X-Miro-Origem (id do
 * aparelho) e, no computador, X-Miro-Maquina. A resposta vai marcada para esse aparelho.
 */
export function deOnde(h: Record<string, string | undefined>): { origem?: string; maquina?: string } {
  const ler = (v: string | undefined, max: number) => {
    try {
      return v ? decodeURIComponent(v).slice(0, max) : undefined;
    } catch {
      return undefined;
    }
  };
  return { origem: ler(h['x-miro-origem'], 64), maquina: ler(h['x-miro-maquina'], 60) };
}
