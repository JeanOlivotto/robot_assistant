/**
 * O app rodando dentro do Electron (apps/desktop), no computador do dono. Duas janelas carregam
 * este mesmo app: ?desktop=bolha (a carinha flutuante com o balão) e ?desktop=painel (o app
 * inteiro numa janela). O Electron expõe `window.roboDesktop` pelo preload — fora dele, nada muda.
 */
export type DesktopMode = 'bolha' | 'painel' | null;

export const DESKTOP: DesktopMode = (() => {
  if (typeof location === 'undefined') return null;
  const m = new URL(location.href).searchParams.get('desktop');
  return m === 'bolha' || m === 'painel' ? m : null;
})();

interface RoboDesktopBridge {
  /** Tamanho da janela da bolha: só a carinha, ou carinha com o balão. A carinha não sai do lugar. */
  modo(m: 'carinha' | 'balao'): void;
  /** Arrastar a carinha (a janela não tem barra de título). */
  mover(dx: number, dy: number): void;
  /** Terminou de arrastar: guarda a posição. */
  soltar(): void;
  painel(acao: 'alternar' | 'abrir' | 'fechar'): void;
  ocupada?(sim: boolean): void;
  dormindo?(sim: boolean): void;
  focar?(): void;
  /** Cria a fonte do som do computador (PipeWire) e devolve o rótulo dela, ou null. */
  somDoSistema?(): Promise<string | null>;
  soltarSomDoSistema?(): void;
  /** O Electron avisa (menu da bandeja) que a voz foi ligada/desligada. */
  aoMudarVoz(cb: (ligada: boolean) => void): void;
  vozMudou(ligada: boolean): void;
  /* "Miro, …" */
  ouvintePronta?(): void;
  ouvinteAudio?(amostras: Float32Array): void;
  ouvinteNome?(nome: string): void;
  ouvinteAlternar?(sim?: boolean): void;
  aoOuvir?(cb: (sim: boolean) => void): void;
  aoCandidato?(cb: (c: { wav: Uint8Array; texto: string }) => void): void;
  aoOuvinteEstado?(cb: (e: string) => void): void;
  comando?(acao: 'reuniao:gravar' | 'reuniao:encerrar'): void;
  aoComando?(cb: (acao: string) => void): void;
  esconder?(): void;
  bracoToken?(token: string): void;
  /** O nome deste computador (o mesmo com que o braço se apresenta ao servidor). */
  maquina?(): string;
  /** Andando para outro monitor (acompanha o monitor em uso), ou parou (null). */
  aoAndar?(cb: (lado: 'esquerda' | 'direita' | null) => void): void;
}

export const desktop: RoboDesktopBridge | null =
  typeof window !== 'undefined' ? ((window as unknown as { roboDesktop?: RoboDesktopBridge }).roboDesktop ?? null) : null;
