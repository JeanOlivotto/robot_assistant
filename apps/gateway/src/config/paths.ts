import { isAbsolute, resolve } from 'node:path';

/** Caminhos relativos do .env partem da raiz do repo (definida em load-env.ts). */
export function rootPath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.env.ROBO_ROOT ?? '.', p);
}
