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
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { acharClaude, semChaveDaApi } from './programador.js';

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

/** Só leitura: sem terminal, sem editar, sem internet, sem MCP, e segredo nem abre. */
const SO_LEITURA = [
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
];

/**
 * Responde a dúvida e resolve com { ok, saida, erro }. `saida` é a explicação (texto).
 * @param {{ pergunta: string }} p
 */
export function consultar(p) {
  console.log(`[consultor] ${String(p.pergunta).slice(0, 120)}`);
  return rodar(String(p.pergunta).slice(0, 2000), { cwd: PASTA, instrucoes: INSTRUCOES, demorou: 'demorou demais lendo o código' });
}

const INSTRUCOES_RESUMO = [
  'O dono pediu, pelo assistente Miro, um resumo de UM arquivo do computador dele, para mandar junto com o arquivo no WhatsApp.',
  'Leia o arquivo inteiro (PDF, texto, planilha, o que for) e escreva o resumo em português: o que é o documento e os pontos principais (valores, datas, nomes, prazos, decisões), no foco que ele pedir.',
  'Texto corrido ou poucos tópicos curtos com "-", sem markdown pesado, no máximo 900 caracteres. Só o resumo: sem "aqui está", sem perguntar nada de volta.',
  'Não copie senhas, tokens, chaves ou dados bancários completos que estejam no arquivo — cite que existem, sem o valor.',
  'Não abra outros arquivos além desse. Se não conseguir ler (formato que não abre, arquivo vazio), diga só isso, em uma frase.',
].join(' ');

/** "~/Downloads/x.pdf" → caminho completo. */
function expandir(caminho) {
  const c = String(caminho ?? '').trim();
  return c === '~' || c.startsWith('~/') || c.startsWith('~\\') ? join(homedir(), c.slice(1)) : c;
}

/**
 * Resume um arquivo para mandar no WhatsApp: o Claude Code (assinatura do dono) lê na pasta do
 * próprio arquivo e devolve só o resumo — o conteúdo não passa pelo LLM do servidor.
 * @param {{ caminho: string, foco?: string }} p
 */
export function resumir(p) {
  const arquivo = resolve(expandir(p.caminho));
  if (!existsSync(arquivo) || !statSync(arquivo).isFile()) return Promise.resolve({ ok: false, saida: '', erro: `não achei o arquivo ${arquivo}` });
  const foco = p.foco ? ` Foco: ${String(p.foco).slice(0, 300)}.` : '';
  console.log(`[consultor] resumo de ${arquivo}`);
  return rodar(`Resuma o arquivo "${basename(arquivo)}" (está nesta pasta).${foco}`, {
    cwd: dirname(arquivo),
    instrucoes: INSTRUCOES_RESUMO,
    demorou: 'demorou demais lendo o arquivo',
    maxTurns: 8,
  });
}

/** Roda o Claude Code só lendo, pela assinatura do dono, e resolve com { ok, saida, erro }. */
function rodar(prompt, { cwd, instrucoes, demorou, maxTurns = 15 }) {
  const bin = acharClaude();
  const args = ['-p', prompt, '--output-format', 'json', '--max-turns', String(maxTurns), ...SO_LEITURA, '--append-system-prompt', instrucoes];

  return new Promise((pronto) => {
    let saida = '';
    let erroTxt = '';
    let fim = false;
    let proc;
    try {
      proc = spawn(bin, args, { cwd, env: semChaveDaApi(), windowsHide: true, shell: WINDOWS && bin.endsWith('.cmd'), stdio: ['ignore', 'pipe', 'pipe'] });
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
      terminar({ ok: false, saida: '', erro: demorou });
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
