import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { FirmwareError, FirmwareService, type FirmwareInfo } from './firmware.service.js';

type PublishedInfo = Omit<FirmwareInfo, 'file'>;

const strip = (info: FirmwareInfo): PublishedInfo => {
  const { file: _file, ...rest } = info;
  return rest;
};

@Controller('api')
export class FirmwareController {
  constructor(private readonly firmware: FirmwareService) {}

  /** Qual firmware está publicado (o `tools/publish-firmware.mjs` usa para conferir). */
  @Get('firmware')
  @UseGuards(AppTokenGuard)
  info(): { firmware: PublishedInfo | null } {
    const latest = this.firmware.latest();
    return { firmware: latest ? strip(latest) : null };
  }

  /** Publica um .bin novo: corpo binário (Content-Type application/octet-stream). */
  @Post('firmware')
  @UseGuards(AppTokenGuard)
  @HttpCode(200)
  publish(@Body() bin: unknown): { firmware: PublishedInfo } {
    if (!Buffer.isBuffer(bin) || !bin.length) {
      throw new BadRequestException('mande o .bin no corpo (Content-Type: application/octet-stream)');
    }
    try {
      return { firmware: strip(this.firmware.publish(bin)) };
    } catch (err) {
      if (err instanceof FirmwareError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  /**
   * O robô baixando a atualização. A chave `k` vem na mensagem `ota` e é derivada do
   * DEVICE_TOKEN — assim o token de verdade não anda em URL nem em log de proxy.
   */
  @Get('device/firmware.bin')
  download(@Query('k') key?: string): StreamableFile {
    if (!this.firmware.keyMatches(key)) throw new ForbiddenException();
    try {
      const bin = this.firmware.binary();
      return new StreamableFile(bin, { type: 'application/octet-stream', length: bin.length });
    } catch (err) {
      if (err instanceof FirmwareError) throw new HttpException(err.message, err.status);
      throw err;
    }
  }

  /** Mesma informação da mensagem `ota`, para conferir com curl sem abrir o WebSocket. */
  @Get('device/firmware/latest')
  latest(@Query('k') key?: string): { version: string; url: string; sha256: string; size: number } | Record<string, never> {
    if (!this.firmware.keyMatches(key)) throw new ForbiddenException();
    const fw = this.firmware.latest();
    if (!fw) return {};
    return { version: fw.version, url: this.firmware.downloadUrl(), sha256: fw.sha256, size: fw.size };
  }
}
