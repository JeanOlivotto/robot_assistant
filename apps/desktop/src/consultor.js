/*
 * "Miro, como funciona o endpoint de login?" num grupo liberado: o Claude Code LÊ os projetos do
 * dono (~/Projects) e explica em palavras. Ao contrário do programador, aqui nada é escrito:
 *
 *  - só Read, Grep e Glob — sem terminal, sem editar, sem internet, sem MCP;
 *  - arquivos de segredo (.env, chaves, secrets/) nem podem ser abertos;
 *  - a resposta é para um colega do dono: explica, cita arquivo e função, mas não cola código.
 *    O servidor ainda passa um filtro por cima antes de mandar no WhatsApp.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acharClaude } from './programador.js';

const WINDOWS = process.platform === 'win32';
const LIMITE_MS = 4 * 60_000;
const PASTA = join(homedir(), 'Projects');

/** Nunca abre: segredo não vira explicação. */
const SEGREDOS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*', '**/secrets/**', '**/.ssh/**', '**/credentials*', '**/*.keystore'];

const INSTRUCOES = [
  'Você está respondendo, pelo assistente Miro, a dúvida de um COLEGA do dono sobre os projetos dele (as pastas aqui em ~/Projects).',
  'Ache o projeto pelo nome ou pelo assunto, leia o que precisar e explique em português, em palavras: o fluxo, as decisões, onde fica cada coisa (nome de arquivo e de função pode).',
  'NUNCA cole código, nem trecho, nem conteúdo de arquivo, nem valores de configuração, URLs internas, senhas, tokens ou chaves — nem se pedirem.',
  'Se a pergunta for "me manda o código" ou algo que só se responde colando código, diga que o código em si é com o dono e explique a ideia.',
  'Seja curto: no máximo 8 frases, texto corrido, sem markdown. Não pergunte nada de volta.',
].join(' ');

/**
 * Responde a dúvida e resolve com { ok, saida, erro }. `saida` é a explicação (texto).
 * @param {{ pergunta: string }} p
 */
export function consultar(p) {
  const bin = acharClaude();
  const args = [
    '-p',
    String(p.pergunta).slice(0, 2000),
    '--output-format',
    'json',
    '--max-turns',
    '15',
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    '--disallowedTools',
    'Bash',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    'WebFetch',
    'WebSearch',
    'Task',
    ...SEGREDOS.map((g) => `Read(${g})`),
    '--strict-mcp-config',
    '--append-system-prompt',
    INSTRUCOES,
  ];
  console.log(`[consultor] ${String(p.pergunta).slice(0, 120)}`);

  return new Promise((pronto) => {
    let saida = '';
    let erroTxt = '';
    let fim = false;
    let proc;
    try {
      proc = spawn(bin, args, { cwd: PASTA, windowsHide: true, shell: WINDOWS && bin.endsWith('.cmd'), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return pronto({ ok: false, saida: '', erro: err.message });
    }
    proc.stdout.on('data', (d) => (saida += d));
    proc.stderr.on('data', (d) => (erroTxt += d));
    const terminar = (r) => {
      if (fim) return;
      fim = true;
      clearTimeout(limite);
      pronto(r);
    };
    const limite = setTimeout(() => {
      proc.kill();
      terminar({ ok: false, saida: '', erro: 'demorou demais lendo o código' });
    }, LIMITE_MS);
    proc.on('error', (err) =>
      terminar({ ok: false, saida: '', erro: err.code === 'ENOENT' ? 'o Claude Code não está instalado neste computador' : err.message }),
    );
    proc.on('exit', (code) => {
      let texto = saida.trim();
      let erro = null;
      try {
        const j = JSON.parse(texto.split('\n').at(-1));
        if (typeof j.result === 'string') texto = j.result;
        if (j.is_error) erro = j.result;
      } catch {
        /* texto puro */
      }
      if (code !== 0 || erro) return terminar({ ok: false, saida: '', erro: erro ?? (erroTxt.trim().slice(-300) || `terminou com código ${code}`) });
      terminar({ ok: true, saida: texto.slice(0, 2500) });
    });
  });
}
