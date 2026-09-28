import type { Face } from '@robo/protocol';

/** Caras que só existem a partir desta versão do firmware — e a mais parecida para quem ainda não tem. */
const NOVAS: Partial<Record<Face, { desde: [number, number, number]; antes: Face }>> = {
  confused: { desde: [0, 17, 0], antes: 'thinking' },
  annoyed: { desde: [0, 17, 0], antes: 'angry' },
};

function versao(fw: string | undefined): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(fw ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function menor(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/**
 * A cara que dá para mostrar num robô com o firmware `fw`. O firmware velho ignora nome que não
 * conhece — sem isto, até o OTA chegar ele ficaria sem reagir nenhuma vez.
 */
export function caraPara(face: Face, fw: string | undefined): Face {
  const nova = NOVAS[face];
  if (!nova) return face;
  const v = versao(fw);
  return v && !menor(v, nova.desde) ? face : nova.antes;
}
