import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { AppTokenGuard } from '../auth/app-token.guard.js';
import { ChatService } from '../chat/chat.service.js';
import { PhotoService } from './photo.service.js';
import { deOnde } from '../chat/de-onde.js';

const MAX_SIDE = 4096;

@Controller('api/chat/photo')
@UseGuards(AppTokenGuard)
export class PhotoController {
  constructor(
    private readonly photos: PhotoService,
    private readonly chat: ChatService,
  ) {}

  /**
   * Foto do app: a imagem no corpo (image/jpeg — o app já reduz), tamanho e legenda na query.
   * Responde logo que guardou; a resposta do robô chega pelo WebSocket, depois que ele "olhar".
   */
  @Post()
  @HttpCode(200)
  send(
    @Body() image: unknown,
    @Headers('content-type') type = '',
    @Query('w') w?: string,
    @Query('h') h?: string,
    @Query('caption') caption = '',
    @Headers() cabecalhos: Record<string, string | undefined> = {},
  ): { id: string } {
    const mime = type.split(';')[0]!.trim().toLowerCase();
    if (!Buffer.isBuffer(image) || !image.length) throw new BadRequestException('mande a foto no corpo (Content-Type image/jpeg)');
    if (!this.photos.accepts(mime)) throw new BadRequestException(`formato não aceito: ${mime || 'vazio'} (use JPEG, PNG ou WebP)`);
    const width = Number(w), height = Number(h);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) {
      throw new BadRequestException('w e h (largura e altura em px) são obrigatórios');
    }
    const id = this.photos.save(image, mime);
    void this.chat.sayPhoto({ id, w: width, h: height }, image, mime, caption.trim().slice(0, 1000), deOnde(cabecalhos));
    return { id };
  }

  /** A foto em si — o app busca com a senha no cabeçalho e mostra como blob. */
  @Get(':id')
  get(@Param('id') id: string): StreamableFile {
    const photo = this.photos.get(id);
    if (!photo) throw new NotFoundException('foto não encontrada');
    return new StreamableFile(photo.data, { type: photo.mime, length: photo.data.length, disposition: 'inline' });
  }
}
