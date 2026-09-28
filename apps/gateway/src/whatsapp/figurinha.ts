import { FACE_DEFS, FACE_EYE_GAP, FACE_LOVE, FACE_MOUTH_DY, FACE_SCREEN, type Face, type FaceDef } from '@robo/protocol';

/**
 * Figurinha animada do WhatsApp com a cara do robô — o mesmo desenho da telinha e do app (a
 * tabela é FACE_DEFS). WebP animado 512×512, que o WhatsApp mostra como figurinha.
 */

const QUADROS = 12;
const QUADRO_MS = 110;
/** Quadros da piscada (a cara "fecha" rapidinho, como no robô). */
const PISCA = new Set([8, 9]);

const cache = new Map<Face, Buffer>();

export async function figurinha(face: Face): Promise<Buffer> {
  const pronta = cache.get(face);
  if (pronta) return pronta;
  // Carregado só aqui: se o binário do sharp falhar no servidor, cai a figurinha — não o gateway.
  const sharp = (await import('sharp')).default;
  const quadros = await Promise.all(
    Array.from({ length: QUADROS }, (_, i) => sharp(Buffer.from(desenhar(face, i / QUADROS, PISCA.has(i)))).png().toBuffer()),
  );
  const webp = await sharp(quadros, { join: { animated: true } })
    .webp({ loop: 0, delay: Array(QUADROS).fill(QUADRO_MS), quality: 80 })
    .toBuffer();
  cache.set(face, webp);
  return webp;
}

/** Um quadro, em SVG. `t` vai de 0 a 1 ao longo da animação. */
export function desenhar(face: Face, t: number, piscando = false): string {
  const d = FACE_DEFS[face];
  const cx = 64;
  const cy = 60;
  // Olhar: parado onde a cara manda, ou passeando devagar de um lado para o outro.
  const [gx, gy] = d.gaze ?? (d.eyes === 'open' ? [Math.round(Math.sin(t * 2 * Math.PI) * 5), 0] : [0, 0]);
  const ey = cy + d.dy + gy;
  const aberto = piscando && d.eyes === 'open' ? 0.12 : 1;

  const partes: string[] = [];
  for (const side of [-1, 1] as const) partes.push(olho(side, cx + (side * FACE_EYE_GAP) / 2 + gx, ey, d, aberto));
  if (d.blush) {
    for (const side of [-1, 1]) {
      partes.push(`<ellipse cx="${cx + (side * FACE_EYE_GAP) / 2 + side * 4 + gx}" cy="${ey + d.h / 2 + 6}" rx="6" ry="3" fill="#ff78aa" opacity="0.85"/>`);
    }
  }
  partes.push(boca(cx + gx / 2, cy + FACE_MOUTH_DY + gy / 2, d));
  partes.push(extras(d, t));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="512" height="512">` +
    `<rect width="128" height="128" rx="24" fill="${FACE_SCREEN}"/>${partes.join('')}</svg>`
  );
}

function olho(side: -1 | 1, ex: number, ey: number, d: FaceDef, aberto: number): string {
  const c = d.color;
  if (d.eyes === 'closed') {
    const rx = d.w / 2;
    return `<path d="M${ex - rx} ${ey - 3} A${rx} 7 0 0 0 ${ex + rx} ${ey - 3}" stroke="${c}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  }
  if (d.eyes === 'x') {
    const s = d.w / 2 - 2;
    return `<g stroke="${c}" stroke-width="4" stroke-linecap="round"><line x1="${ex - s}" y1="${ey - s}" x2="${ex + s}" y2="${ey + s}"/><line x1="${ex - s}" y1="${ey + s}" x2="${ex + s}" y2="${ey - s}"/></g>`;
  }
  if (d.eyes === 'heart') return coracao(ex, ey, d.w, c);

  const w = d.w;
  const base = side > 0 && d.squint ? (d.h * (100 - d.squint)) / 100 : d.h;
  const h = Math.max(3, base * aberto);
  const k = h / d.h;
  const top = ey - h / 2;
  const outer = ex + side * (w / 2 + 1);
  const inner = ex - side * (w / 2 + 1);
  let s = `<rect x="${ex - w / 2}" y="${top}" width="${w}" height="${h}" rx="${Math.min(d.r, h / 2)}" fill="${c}"/>`;
  if (d.lidTop > 0) s += `<rect x="${ex - w / 2 - 1}" y="${top - 1}" width="${w + 2}" height="${d.lidTop * k + 1}" fill="${FACE_SCREEN}"/>`;
  if (d.lidBot > 0) s += `<ellipse cx="${ex}" cy="${top + h - d.lidBot * k + w / 2}" rx="${w / 2 + 2}" ry="${w / 2}" fill="${FACE_SCREEN}"/>`;
  if (d.slant > 0) s += `<polygon points="${outer},${top - 1} ${outer},${top + d.slant * k} ${inner},${top - 1}" fill="${FACE_SCREEN}"/>`;
  if (d.slant < 0) s += `<polygon points="${inner},${top - 1} ${inner},${top - d.slant * k} ${outer},${top - 1}" fill="${FACE_SCREEN}"/>`;
  return s;
}

function boca(mx: number, my: number, d: FaceDef): string {
  const rx = d.mw / 2;
  const h = d.mh;
  const c = d.color;
  switch (d.mouth) {
    case 'smile':
      return `<path d="M${mx - rx} ${my - h / 2} A${rx} ${h} 0 0 0 ${mx + rx} ${my - h / 2}" stroke="${c}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    case 'grin':
      return `<path d="M${mx - rx} ${my - h / 2} A${rx} ${h} 0 0 0 ${mx + rx} ${my - h / 2} Z" fill="${c}"/>`;
    case 'frown':
      return `<path d="M${mx - rx} ${my + h / 2} A${rx} ${h} 0 0 1 ${mx + rx} ${my + h / 2}" stroke="${c}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    case 'o':
      return `<ellipse cx="${mx}" cy="${my}" rx="${Math.max(rx - 1, 1.5)}" ry="${Math.max(h / 2 - 1, 1.5)}" stroke="${c}" stroke-width="2.5" fill="none"/>`;
    case 'flat':
      return `<rect x="${mx - rx}" y="${my - h / 2}" width="${d.mw}" height="${h}" rx="${h / 2}" fill="${c}"/>`;
    case 'tilt':
      return `<line x1="${mx - rx + 2}" y1="${my + h / 2}" x2="${mx + rx + 2}" y2="${my - h / 2}" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`;
    default:
      return '';
  }
}

function coracao(cx: number, cy: number, size: number, fill: string, opacity = 1): string {
  const r = Math.max(1, Math.floor(size / 4));
  const ly = cy - r / 2;
  return (
    `<g fill="${fill}" opacity="${opacity.toFixed(2)}"><circle cx="${cx - r}" cy="${ly}" r="${r + 0.5}"/><circle cx="${cx + r}" cy="${ly}" r="${r + 0.5}"/>` +
    `<polygon points="${cx - 2 * r - 0.5},${ly} ${cx + 2 * r + 0.5},${ly} ${cx},${cy + size / 2}"/></g>`
  );
}

/** Os enfeites de cada cara, andando com `t` (0..1) — voltam ao começo no fim, para o loop não pular. */
function extras(d: FaceDef, t: number): string {
  const c = d.color;
  let s = '';
  if (d.zzz) {
    for (let i = 0; i < 3; i++) {
      const p = (t + i / 3) % 1;
      s += `<text x="${98 + p * 12}" y="${44 - p * 20}" font-size="${9 + p * 6}" font-family="monospace" font-weight="700" fill="${c}" opacity="${(1 - p).toFixed(2)}">z</text>`;
    }
  }
  if (d.hearts) {
    for (let i = 0; i < 3; i++) {
      const p = (t + i / 3) % 1;
      s += coracao(i % 2 ? 118 : 10, 90 - p * 40, 9, FACE_LOVE, 1 - p);
    }
  }
  if (d.sweat) {
    const y = 38 + t * 10;
    s += `<g fill="#6ebeff"><circle cx="105" cy="${y + 5}" r="3"/><polygon points="102,${y + 4} 108,${y + 4} 105,${y - 2}"/></g>`;
  }
  if (d.dots) {
    const alto = Math.floor(t * 4) % 4;
    for (let i = 0; i < 3; i++) s += `<circle cx="${92 + i * 8}" cy="${alto === i ? 22 : 24}" r="${alto === i ? 3 : 2.5}" fill="${c}"/>`;
  }
  if (d.question) {
    const opacity = t < 0.66 ? 1 : 1 - (t - 0.66) / 0.34;
    s += `<text x="100" y="${30 - (Math.floor(t * 6) % 2)}" font-size="18" font-family="monospace" font-weight="700" fill="${c}" opacity="${opacity.toFixed(2)}">?</text>`;
  }
  if (d.steam) {
    for (const [i, side] of [-1, 1].entries()) {
      const p = (t + i / 2) % 1;
      s += `<circle cx="${64 + side * (42 + p * 4)}" cy="${30 - p * 18}" r="${3.5 + p * 2}" fill="#c8c8c8" opacity="${(0.9 * (1 - p)).toFixed(2)}"/>`;
    }
  }
  return s;
}
