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

  // O webapp (apps/web) é servido pelo próprio gateway depois do build.
  const web = rootPath('apps/web/dist');
  if (existsSync(web)) app.useStaticAssets(web);
  else Logger.warn('apps/web/dist não existe — rode "pnpm --filter @robo/web build"', 'Bootstrap');

  const port = Number(process.env.PORT ?? 8080);
  // 0.0.0.0: o robô e o celular conectam pela rede local, não só pelo localhost.
  await app.listen(port, '0.0.0.0');
  Logger.log(`Gateway em http://0.0.0.0:${port} (webapp em /, robô em /device)`, 'Bootstrap');
}
await bootstrap();
