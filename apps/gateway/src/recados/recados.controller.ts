import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Logger,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { rootPath } from '../config/paths.js';
import { RecadoTokenGuard, type RequestDeApp } from './recado-token.guard.js';
import { MudarApp, NovaApp, RecadosAppsService } from './recados-apps.service.js';
import { RecadosService } from './recados.service.js';
import { NovoRecado, RecadosStore } from './recados.store.js';
import { PASTA_SKILL, zipDaSkill } from './skill-zip.js';

/** O endereço que a skill traz escrito — trocado pelo deste servidor na hora de baixar. */
const URL_NA_SKILL = 'https://srv1966497.hstgr.cloud';

function validar<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(z.prettifyError(parsed.error));
  return parsed.data;
}

/**
 * POST /api/recados — as aplicações do dono deixam recado (chave da aplicação).
 * O resto é do dono (APP_TOKEN): ver e dar baixa nos recados, cadastrar aplicações e gerar as chaves.
 */
@Controller('api/recados')
export class RecadosController {
  private readonly log = new Logger(RecadosController.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly recados: RecadosService,
    private readonly store: RecadosStore,
    private readonly apps: RecadosAppsService,
  ) {}

  @Post()
  @HttpCode(202)
  @UseGuards(RecadoTokenGuard)
  receber(@Req() req: RequestDeApp, @Body() body: unknown) {
    const app = req.recadoApp!;
    if (!this.recados.dentroDoRitmo(app)) throw new HttpException('recados demais por minuto', HttpStatus.TOO_MANY_REQUESTS);
    return this.recados.receber(app, validar(NovoRecado, body));
  }

  @Get()
  @UseGuards(AppTokenGuard)
  listar(@Query('app') app?: string, @Query('todos') todos?: string) {
    return todos ? this.store.recentes(50, app) : this.store.abertos(app);
  }

  @Post(':id/baixa')
  @HttpCode(200)
  @UseGuards(AppTokenGuard)
  baixa(@Param('id') id: string) {
    const [r] = this.store.darBaixa([id]);
    if (!r) throw new NotFoundException('recado aberto não encontrado');
    return r;
  }

  /** A skill do Claude Code que implanta os recados num sistema, pronta para descompactar em ~/.claude/skills. */
  @Get('skill.zip')
  @UseGuards(AppTokenGuard)
  @Header('Content-Type', 'application/zip')
  @Header('Content-Disposition', 'attachment; filename="miro-recados.zip"')
  @Header('Cache-Control', 'no-store')
  skill(): StreamableFile {
    const base = this.cfg.PUBLIC_URL.replace(/\/+$/, '');
    try {
      return new StreamableFile(zipDaSkill(rootPath(PASTA_SKILL), (t) => t.replaceAll(URL_NA_SKILL, base)));
    } catch (err) {
      this.log.error(`Skill de recados não encontrada em ${PASTA_SKILL}: ${(err as Error).message}`);
      throw new InternalServerErrorException('a skill não está neste servidor');
    }
  }

  /** As aplicações, com quantos recados abertos cada uma tem e como a última sonda do /health a viu. */
  @Get('apps')
  @UseGuards(AppTokenGuard)
  listarApps() {
    const abertos = this.store.abertos();
    return this.apps.listar().map((a) => ({
      ...a,
      abertos: abertos.filter((r) => r.app === a.nome).length,
      saude: a.saudeUrl ? this.recados.estadoSaude(a.nome) : null,
    }));
  }

  /** Cadastra e devolve a chave — a única vez que ela aparece. */
  @Post('apps')
  @HttpCode(201)
  @UseGuards(AppTokenGuard)
  criarApp(@Body() body: unknown) {
    const { nome, saudeUrl } = validar(NovaApp, body);
    const r = this.apps.criar(nome, saudeUrl || undefined);
    if ('erro' in r) throw new ConflictException(r.erro);
    if (saudeUrl) void this.recados.vigiar(); // primeira sonda já, sem esperar a rodada
    return r;
  }

  @Patch('apps/:nome')
  @UseGuards(AppTokenGuard)
  mudarApp(@Param('nome') nome: string, @Body() body: unknown) {
    const mudanca = validar(MudarApp, body);
    const app = this.apps.mudar(nome, mudanca);
    if (!app) throw new NotFoundException('aplicação não encontrada');
    if (mudanca.saudeUrl || mudanca.ativo) void this.recados.vigiar();
    return app;
  }

  /** Chave nova; a anterior para de valer na hora. */
  @Post('apps/:nome/chave')
  @HttpCode(200)
  @UseGuards(AppTokenGuard)
  novaChave(@Param('nome') nome: string) {
    const token = this.apps.novaChave(nome);
    if (!token) throw new NotFoundException('aplicação não encontrada');
    return { app: this.apps.get(nome), token };
  }

  /** Apaga a aplicação (a chave para de valer); os recados dela continuam no histórico. */
  @Delete('apps/:nome')
  @UseGuards(AppTokenGuard)
  apagarApp(@Param('nome') nome: string) {
    if (!this.apps.apagar(nome)) throw new NotFoundException('aplicação não encontrada');
    return { ok: true };
  }
}
