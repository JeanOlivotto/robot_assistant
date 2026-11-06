import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/** A skill de recados do Claude Code, no repo — o app oferece para baixar e instalar. */
export const PASTA_SKILL = 'tools/miro-recados-skill';
export const NOME_SKILL = 'miro-recados';

/**
 * Zipa a pasta da skill com tudo dentro de `miro-recados/`: descompactada em ~/.claude/skills, já
 * fica no lugar. `trocar` ajusta o texto (ex.: o endereço do servidor) sem mexer no arquivo do repo.
 */
export function zipDaSkill(pasta: string, trocar: (texto: string) => string = (t) => t): Buffer {
  const arquivos = listar(pasta).map((caminho) => {
    const nome = `${NOME_SKILL}/${relative(pasta, caminho).split(sep).join('/')}`;
    return { nome, dados: Buffer.from(trocar(readFileSync(caminho, 'utf8'))) };
  });
  return zip(arquivos);
}

function listar(pasta: string): string[] {
  return readdirSync(pasta)
    .filter((n) => !n.startsWith('.') && n !== '__pycache__' && !n.endsWith('.pyc'))
    .sort()
    .flatMap((n) => {
      const p = join(pasta, n);
      return statSync(p).isDirectory() ? listar(p) : [p];
    });
}

/** ZIP mínimo (deflate, nomes em UTF-8) — o que o unzip, o Explorer e o Expand-Archive abrem. */
export function zip(arquivos: { nome: string; dados: Buffer }[], quando = new Date()): Buffer {
  const hora = (quando.getHours() << 11) | (quando.getMinutes() << 5) | (quando.getSeconds() >> 1);
  const data = ((quando.getFullYear() - 1980) << 9) | ((quando.getMonth() + 1) << 5) | quando.getDate();
  const locais: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const { nome, dados } of arquivos) {
    const n = Buffer.from(nome, 'utf8');
    const comprimido = deflateRawSync(dados);
    const crc = crc32(dados);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versão necessária
    local.writeUInt16LE(0x0800, 6); // nome em UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(n.length, 26);
    local.writeUInt16LE(0, 28);
    locais.push(local, n, comprimido);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); // feito por
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(hora, 12);
    c.writeUInt16LE(data, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comprimido.length, 20);
    c.writeUInt32LE(dados.length, 24);
    c.writeUInt16LE(n.length, 28);
    // extra, comentário, disco, atributos internos/externos: zero
    c.writeUInt32LE(offset, 42);
    central.push(c, n);

    offset += local.length + n.length + comprimido.length;
  }

  const tamanhoCentral = central.reduce((t, b) => t + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(tamanhoCentral, 12);
  fim.writeUInt32LE(offset, 16);
  return Buffer.concat([...locais, ...central, fim]);
}
