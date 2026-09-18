import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/* Importado primeiro no main.ts: o .env da raiz do monorepo vale para todos os apps.
   Caminhos relativos do .env (chave do Google, pasta de dados) partem dessa raiz. */
for (const p of [resolve('.env'), resolve('../../.env')]) {
  if (existsSync(p)) {
    process.loadEnvFile(p);
    process.env.ROBO_ROOT ??= dirname(p);
    break;
  }
}

// Datas "dia inteiro" viram meia-noite no fuso do processo.
process.env.TZ = process.env.TZ_NAME || 'America/Sao_Paulo';
