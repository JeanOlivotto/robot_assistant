import './load-env.js';
import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { rootPath } from './config/paths.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  // Mensagens de voz chegam como binário (AAC do iPhone, Opus do Chrome, WAV).
  app.useBodyParser('raw', { type: ['audio/*', 'image/*', 'video/mp4', 'video/webm', 'application/octet-stream'], limit: '12mb' });
  // O atalho da Siri pode mandar o ditado como texto puro.
  app.useBodyParser('text', { type: 'text/plain', limit: '16kb' });

  // O webapp (apps/web) é servido pelo próprio gateway depois do build.
  const web = rootPath('apps/web/dist');
  // O .ps1 do instalador do Windows (miro/instalar.ps1) sai como texto: o `irm … | iex` do
  // PowerShell precisa receber string, não bytes.
  if (existsSync(web))
    app.useStaticAssets(web, {
      setHeaders: (res, path) => {
        if (path.endsWith('.ps1')) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      },
    });
  else Logger.warn('apps/web/dist não existe — rode "pnpm --filter @robo/web build"', 'Bootstrap');

  const port = Number(process.env.PORT ?? 8080);
  // 0.0.0.0: o robô e o celular conectam pela rede local, não só pelo localhost.
  await app.listen(port, '0.0.0.0');
  Logger.log(`Gateway em http://0.0.0.0:${port} (webapp em /, robô em /device)`, 'Bootstrap');
}
await bootstrap();
