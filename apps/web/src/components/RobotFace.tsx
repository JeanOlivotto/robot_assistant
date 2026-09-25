import type { Face } from '@robo/protocol';

type Eyes = 'open' | 'closed' | 'x' | 'heart';
type Mouth = 'none' | 'smile' | 'grin' | 'frown' | 'o' | 'flat';

interface Def {
  eyes: Eyes;
  mouth: Mouth;
  w: number;
  h: number;
  r: number;
  lidTop: number;
  lidBot: number;
  slant: number;
  dy: number;
  mw: number;
  mh: number;
  color: string;
  gaze?: [number, number];
  blush?: boolean;
  sweat?: boolean;
  zzz?: boolean;
  hearts?: boolean;
  dots?: boolean;
}

const EYE = '#5ae6f0';
const LOVE = '#ff5a8c';
const ERR = '#ff5050';
const ANGRY = '#ff8c3c';
const EVIL = '#be5aff';
const SCREEN = '#000';

/* Mesmos números de firmware/main/core/face.c — manter os dois em sincronia. */
const FACE_DEFS: Record<Face, Def> = {
  neutral: { eyes: 'open', mouth: 'smile', w: 24, h: 30, r: 8, lidTop: 0, lidBot: 0, slant: 0, dy: 0, mw: 12, mh: 5, color: EYE },
  happy: { eyes: 'open', mouth: 'grin', w: 24, h: 30, r: 8, lidTop: 0, lidBot: 13, slant: 0, dy: 0, mw: 16, mh: 8, color: EYE, blush: true },
  love: { eyes: 'heart', mouth: 'grin', w: 26, h: 26, r: 8, lidTop: 0, lidBot: 0, slant: 0, dy: 0, mw: 16, mh: 8, color: LOVE, blush: true, hearts: true },
  sleepy: { eyes: 'open', mouth: 'flat', w: 24, h: 30, r: 8, lidTop: 16, lidBot: 0, slant: 0, dy: 2, mw: 8, mh: 3, color: EYE },
  sleeping: { eyes: 'closed', mouth: 'o', w: 24, h: 12, r: 6, lidTop: 0, lidBot: 0, slant: 0, dy: 4, mw: 6, mh: 6, color: EYE, zzz: true },
  worried: { eyes: 'open', mouth: 'frown', w: 22, h: 28, r: 8, lidTop: 0, lidBot: 0, slant: 10, dy: 0, mw: 12, mh: 5, color: EYE, sweat: true },
  surprised: { eyes: 'open', mouth: 'o', w: 26, h: 34, r: 13, lidTop: 0, lidBot: 0, slant: 0, dy: -2, mw: 9, mh: 10, color: EYE },
  sad: { eyes: 'open', mouth: 'frown', w: 22, h: 24, r: 8, lidTop: 3, lidBot: 0, slant: 8, dy: 4, mw: 14, mh: 6, color: EYE },
  error: { eyes: 'x', mouth: 'flat', w: 20, h: 20, r: 0, lidTop: 0, lidBot: 0, slant: 0, dy: 0, mw: 14, mh: 3, color: ERR },
  thinking: { eyes: 'open', mouth: 'flat', w: 22, h: 24, r: 8, lidTop: 6, lidBot: 0, slant: 0, dy: -2, mw: 8, mh: 3, color: EYE, gaze: [-7, -5], dots: true },
  bored: { eyes: 'open', mouth: 'flat', w: 24, h: 30, r: 8, lidTop: 14, lidBot: 0, slant: 0, dy: 3, mw: 10, mh: 2, color: EYE, gaze: [8, 2] },
  jamming: { eyes: 'open', mouth: 'grin', w: 24, h: 28, r: 8, lidTop: 0, lidBot: 17, slant: 0, dy: 0, mw: 16, mh: 8, color: EYE, blush: true },
  angry: { eyes: 'open', mouth: 'frown', w: 24, h: 22, r: 6, lidTop: 0, lidBot: 0, slant: -13, dy: 1, mw: 14, mh: 5, color: ANGRY },
  evil: { eyes: 'open', mouth: 'grin', w: 24, h: 20, r: 5, lidTop: 6, lidBot: 0, slant: -14, dy: 1, mw: 15, mh: 6, color: EVIL },
};

const EYE_GAP = 48;
const MOUTH_DY = 27;

function Heart({ cx, cy, size, fill }: { cx: number; cy: number; size: number; fill: string }) {
  const r = Math.max(1, Math.floor(size / 4));
  const ly = cy - r / 2;
  return (
    <g fill={fill}>
      <circle cx={cx - r} cy={ly} r={r + 0.5} />
      <circle cx={cx + r} cy={ly} r={r + 0.5} />
      <polygon points={`${cx - 2 * r - 0.5},${ly} ${cx + 2 * r + 0.5},${ly} ${cx},${cy + size / 2}`} />
    </g>
  );
}

function Eye({ side, ex, ey, d, color }: { side: -1 | 1; ex: number; ey: number; d: Def; color: string }) {
  if (d.eyes === 'closed') {
    const rx = d.w / 2;
    return <path d={`M${ex - rx} ${ey - 3} A${rx} 7 0 0 0 ${ex + rx} ${ey - 3}`} stroke={color} strokeWidth={3} fill="none" strokeLinecap="round" />;
  }
  if (d.eyes === 'x') {
    const s = d.w / 2 - 2;
    return (
      <g stroke={color} strokeWidth={4} strokeLinecap="round">
        <line x1={ex - s} y1={ey - s} x2={ex + s} y2={ey + s} />
        <line x1={ex - s} y1={ey + s} x2={ex + s} y2={ey - s} />
      </g>
    );
  }
  if (d.eyes === 'heart') return <Heart cx={ex} cy={ey} size={d.w} fill={color} />;

  const { w, h } = d;
  const top = ey - h / 2;
  const outer = ex + side * (w / 2 + 1);
  const inner = ex - side * (w / 2 + 1);
  return (
    <g>
      <rect x={ex - w / 2} y={top} width={w} height={h} rx={Math.min(d.r, h / 2)} fill={color} />
      {d.lidTop > 0 && <rect x={ex - w / 2 - 1} y={top - 1} width={w + 2} height={d.lidTop + 1} fill={SCREEN} />}
      {d.lidBot > 0 && <ellipse cx={ex} cy={top + h - d.lidBot + w / 2} rx={w / 2 + 2} ry={w / 2} fill={SCREEN} />}
      {/* slant > 0 derruba o canto de fora (triste); < 0 fecha o de dentro (bravo) */}
      {d.slant > 0 && <polygon points={`${outer},${top - 1} ${outer},${top + d.slant} ${inner},${top - 1}`} fill={SCREEN} />}
      {d.slant < 0 && <polygon points={`${inner},${top - 1} ${inner},${top - d.slant} ${outer},${top - 1}`} fill={SCREEN} />}
    </g>
  );
}

function MouthShape({ mx, my, d, color }: { mx: number; my: number; d: Def; color: string }) {
  const rx = d.mw / 2;
  const h = d.mh;
  switch (d.mouth) {
    case 'smile':
      return <path d={`M${mx - rx} ${my - h / 2} A${rx} ${h} 0 0 0 ${mx + rx} ${my - h / 2}`} stroke={color} strokeWidth={3} fill="none" strokeLinecap="round" />;
    case 'grin':
      return <path d={`M${mx - rx} ${my - h / 2} A${rx} ${h} 0 0 0 ${mx + rx} ${my - h / 2} Z`} fill={color} />;
    case 'frown':
      return <path d={`M${mx - rx} ${my + h / 2} A${rx} ${h} 0 0 1 ${mx + rx} ${my + h / 2}`} stroke={color} strokeWidth={3} fill="none" strokeLinecap="round" />;
    case 'o':
      return <ellipse cx={mx} cy={my} rx={Math.max(rx - 1, 1.5)} ry={Math.max(h / 2 - 1, 1.5)} stroke={color} strokeWidth={2.5} fill="none" />;
    case 'flat':
      return <rect x={mx - rx} y={my - h / 2} width={d.mw} height={h} rx={h / 2} fill={color} />;
    default:
      return null;
  }
}

/** Rostinho do robô desenhado igual à telinha de 128×128. `face = null` = robô desligado. */
export function RobotFace({ face, size = 128, className = '' }: { face: Face | null; size?: number; className?: string }) {
  const name: Face = face ?? 'sleeping';
  const d = FACE_DEFS[name];
  const color = face ? d.color : '#39404d';
  const [gx, gy] = d.gaze ?? [0, 0];
  const cx = 64;
  const cy = 60;
  const ey = cy + d.dy;
  const wanders = d.eyes === 'open' && !d.gaze;

  return (
    <svg viewBox="0 0 128 128" width={size} height={size} className={`face ${className}`} role="img" aria-label={`Miro ${name}`}>
      <rect width="128" height="128" rx="24" fill={SCREEN} />
      <g transform={`translate(${gx} ${gy})`}>
        <g className={wanders ? 'face-wander' : undefined}>
          <g className={d.eyes === 'open' && face ? 'face-blink' : undefined}>
            <Eye side={-1} ex={cx - EYE_GAP / 2} ey={ey} d={d} color={color} />
            <Eye side={1} ex={cx + EYE_GAP / 2} ey={ey} d={d} color={color} />
          </g>
          {d.blush && face && (
            <g fill="#ff78aa" opacity={0.85}>
              <ellipse cx={cx - EYE_GAP / 2 - 4} cy={ey + d.h / 2 + 6} rx={6} ry={3} />
              <ellipse cx={cx + EYE_GAP / 2 + 4} cy={ey + d.h / 2 + 6} rx={6} ry={3} />
            </g>
          )}
        </g>
        <MouthShape mx={cx} my={cy + MOUTH_DY} d={d} color={color} />
      </g>

      {d.zzz && (
        <g fill={color} fontFamily="ui-monospace, monospace" fontWeight={700}>
          {[0, 1, 2].map((i) => (
            <text key={i} x={98} y={44} fontSize={10} className="face-zzz" style={{ animationDelay: `${i * 0.9}s` }}>
              z
            </text>
          ))}
        </g>
      )}
      {d.hearts && face && [0, 1, 2].map((i) => (
        <g key={i} className="face-heart" style={{ animationDelay: `${i * 0.7}s` }}>
          <Heart cx={i % 2 ? 118 : 10} cy={86} size={9} fill={LOVE} />
        </g>
      ))}
      {d.sweat && face && (
        <g className="face-sweat" fill="#6ebeff">
          <circle cx={105} cy={43} r={3} />
          <polygon points="102,42 108,42 105,36" />
        </g>
      )}
      {d.dots && face && (
        <g fill={color}>
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={92 + i * 8} cy={24} r={2.5} className="face-dot" style={{ animationDelay: `${i * 0.2}s` }} />
          ))}
        </g>
      )}
    </svg>
  );
}
