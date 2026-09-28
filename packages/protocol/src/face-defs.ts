/** Como cada expressão é desenhada — a telinha de 128×128, o app e as figurinhas usam os mesmos números. */
import type { Face } from './messages.js';

export type FaceEyes = 'open' | 'closed' | 'x' | 'heart';
export type FaceMouth = 'none' | 'smile' | 'grin' | 'frown' | 'o' | 'flat' | 'tilt';

export interface FaceDef {
  eyes: FaceEyes;
  mouth: FaceMouth;
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
  /** "?" em cima (confuso). */
  question?: boolean;
  /** Fumacinha saindo da cabeça (irritado). */
  steam?: boolean;
  /** O olho da direita fica menor, em % da altura: olhos desencontrados. */
  squint?: number;
}

export const FACE_EYE = '#5ae6f0';
export const FACE_LOVE = '#ff5a8c';
export const FACE_ERR = '#ff5050';
export const FACE_ANGRY = '#ff8c3c';
export const FACE_EVIL = '#be5aff';
export const FACE_ANNOY = '#ffc83c';
export const FACE_SCREEN = '#000';

/* Mesmos números de firmware/main/core/face.c — manter os dois em sincronia. Quem desenha: o app
   (RobotFace) e o gateway (figurinhas do WhatsApp). */
export const FACE_DEFS: Record<Face, FaceDef> = {
  neutral: { eyes: 'open', mouth: 'smile', w: 24, h: 30, r: 8, lidTop: 0, lidBot: 0, slant: 0, dy: 0, mw: 12, mh: 5, color: FACE_EYE },
  happy: { eyes: 'open', mouth: 'grin', w: 24, h: 30, r: 8, lidTop: 0, lidBot: 13, slant: 0, dy: 0, mw: 16, mh: 8, color: FACE_EYE, blush: true },
  love: { eyes: 'heart', mouth: 'grin', w: 26, h: 26, r: 8, lidTop: 0, lidBot: 0, slant: 0, dy: 0, mw: 16, mh: 8, color: FACE_LOVE, blush: true, hearts: true },
  sleepy: { eyes: 'open', mouth: 'flat', w: 24, h: 30, r: 8, lidTop: 16, lidBot: 0, slant: 0, dy: 2, mw: 8, mh: 3, color: FACE_EYE },
  sleeping: { eyes: 'closed', mouth: 'o', w: 24, h: 12, r: 6, lidTop: 0, lidBot: 0, slant: 0, dy: 4, mw: 6, mh: 6, color: FACE_EYE, zzz: true },
  worried: { eyes: 'open', mouth: 'frown', w: 22, h: 28, r: 8, lidTop: 0, lidBot: 0, slant: 10, dy: 0, mw: 12, mh: 5, color: FACE_EYE, sweat: true },
  surprised: { eyes: 'open', mouth: 'o', w: 26, h: 34, r: 13, lidTop: 0, lidBot: 0, slant: 0, dy: -2, mw: 9, mh: 10, color: FACE_EYE },
  sad: { eyes: 'open', mouth: 'frown', w: 22, h: 24, r: 8, lidTop: 3, lidBot: 0, slant: 8, dy: 4, mw: 14, mh: 6, color: FACE_EYE },
  error: { eyes: 'x', mouth: 'flat', w: 20, h: 20, r: 0, lidTop: 0, lidBot: 0, slant: 0, dy: 0, mw: 14, mh: 3, color: FACE_ERR },
  thinking: { eyes: 'open', mouth: 'flat', w: 22, h: 24, r: 8, lidTop: 6, lidBot: 0, slant: 0, dy: -2, mw: 8, mh: 3, color: FACE_EYE, gaze: [-7, -5], dots: true },
  bored: { eyes: 'open', mouth: 'flat', w: 24, h: 30, r: 8, lidTop: 14, lidBot: 0, slant: 0, dy: 3, mw: 10, mh: 2, color: FACE_EYE, gaze: [8, 2] },
  jamming: { eyes: 'open', mouth: 'grin', w: 24, h: 28, r: 8, lidTop: 0, lidBot: 17, slant: 0, dy: 0, mw: 16, mh: 8, color: FACE_EYE, blush: true },
  angry: { eyes: 'open', mouth: 'frown', w: 24, h: 22, r: 6, lidTop: 0, lidBot: 0, slant: -13, dy: 1, mw: 14, mh: 5, color: FACE_ANGRY },
  evil: { eyes: 'open', mouth: 'grin', w: 24, h: 20, r: 5, lidTop: 6, lidBot: 0, slant: -14, dy: 1, mw: 15, mh: 6, color: FACE_EVIL },
  confused: { eyes: 'open', mouth: 'tilt', w: 24, h: 30, r: 8, lidTop: 0, lidBot: 0, slant: 0, dy: 0, mw: 12, mh: 4, color: FACE_EYE, gaze: [4, -3], question: true, squint: 45 },
  annoyed: { eyes: 'open', mouth: 'flat', w: 24, h: 28, r: 7, lidTop: 11, lidBot: 0, slant: -6, dy: 1, mw: 13, mh: 3, color: FACE_ANNOY, gaze: [7, 1], steam: true },
};

export const FACE_EYE_GAP = 48;
export const FACE_MOUTH_DY = 27;
