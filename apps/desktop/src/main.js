/*
 * O robô no computador. Duas janelas carregam o mesmo app web do servidor (cada deploy já
 * atualiza o desktop, sem reinstalar):
 *   - a BOLHA: a carinha redonda, sem moldura, transparente, sempre por cima e em todas as áreas
 *     de trabalho; cresce para mostrar o balão quando ele fala;
 *   - o PAINEL: o app inteiro (chat, agenda, pendências, reunião) numa janela, aberto pela bolha.
 * O Electron só faz o que o navegador não faz: janela flutuante, bandeja, atalho global
 * (Super+K — o Super+R do sxhkd gira a área de trabalho), e a carinha que segue o monitor em uso,
 * andando de um para o outro.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, Tray, app, globalShortcut, ipcMain, screen, session, shell } from 'electron';
import { Ouvinte } from './ouvinte.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.ROBO_URL || 'https://srv1966497.hstgr.cloud').replace(/\/+$/, '');
const ORIGEM = new URL(BASE).origin;
const ATALHO = process.env.ROBO_ATALHO || 'Super+K';
/** Caminhada: atravessar de monitor é rápido; passear é devagar, como quem está à toa. */
const TROCA = { px_s: 1300, min: 700, max: 2200 };
const PASSEIO = { px_s: 160, min: 2500, max: 9000 };
/** De quanto em quanto tempo ele resolve dar uma volta, e quanto respeita você depois de arrastá-lo. */
const PASSEIO_A_CADA_MS = { min: 25_000, max: 70_000 };
const PARADO_DEPOIS_DE_ARRASTAR_MS = 3 * 60_000;
const ICONE = join(AQUI, '../assets/icone-128.png');
const ICONE_BANDEJA = join(AQUI, '../assets/icone-22.png');

/* Tamanhos da janela da bolha. A carinha fica sempre no canto de baixo à direita da janela, e
   é esse canto que não sai do lugar quando o balão abre ou fecha. */
const CARINHA = { w: 96, h: 96 };
const BALAO = { w: 372, h: 300 };
const MARGEM = 24;

app.setName('robo-desktop'); // o WM_CLASS no X11 sai "robo-desktop": é por ele que o bspwm reconhece as janelas

let bolha = null;
/*
 * Onde a carinha mora (canto de baixo à direita da janela da bolha). O app guarda isto por conta
 * própria em vez de perguntar para a janela: o bspwm leva toda janela flutuante nova para o
 * monitor em foco, e por um instante o Electron acha que ela está onde pediu, não onde foi parar.
 */
let canto = null;
/** Quando o próprio app posicionou a bolha por último (para não confundir com você arrastando). */
let posicionadoEm = 0;
/** Onde a carinha está no monitor, em proporção (0–1): ao trocar de monitor, vai ao ponto equivalente. */
let relativo = null;
let andando = null; // a caminhada em curso (setInterval)
let passear = true; // passeia pela tela sozinho (bandeja liga/desliga)
let ocupada = false; // balão aberto ou mouse em cima: fica quieta
let arrastadaEm = 0;
let dormindo = false; // o robô está dormindo: a carinha não se mexe até alguém acordá-lo
let ouvir = true; // escuta o "Miro, …" (o microfone do balão e a bandeja ligam/desligam)
let nomeDele = 'Miro';
let conferirMonitor = () => {};
let painel = null;
let bandeja = null;
let modoBolha = 'carinha';
let visivel = true;
let painelAberto = false;
let vozLigada = false;

/* ── o que fica guardado entre uma vez e outra ──────────────────────── */

const ESTADO = join(app.getPath('userData'), 'estado.json');

function lerEstado() {
  try {
    return JSON.parse(readFileSync(ESTADO, 'utf8'));
  } catch {
    return {};
  }
}

function salvarEstado(parcial) {
  try {
    mkdirSync(dirname(ESTADO), { recursive: true });
    writeFileSync(ESTADO, JSON.stringify({ ...lerEstado(), ...parcial }));
  } catch (err) {
    console.error(`[robo] não salvei o estado: ${err.message}`);
  }
}

/* ── bolha ───────────────────────────────────────────────────────────── */

/** A carinha no monitor dado, no ponto equivalente (mesma proporção); sem proporção, no canto de baixo à direita. */
function cantoNo(area) {
  if (!relativo) return { x: area.x + area.width - MARGEM, y: area.y + area.height - MARGEM };
  const x = area.x + CARINHA.w + relativo.fx * (area.width - CARINHA.w);
  const y = area.y + CARINHA.h + relativo.fy * (area.height - CARINHA.h);
  return { x: Math.round(x), y: Math.round(y) };
}

/** Guarda onde a carinha está, em proporção do monitor dela. */
function lembrarPosicao() {
  const c = cantoAtual();
  const area = screen.getDisplayNearestPoint(c).workArea;
  const fx = (c.x - area.x - CARINHA.w) / Math.max(1, area.width - CARINHA.w);
  const fy = (c.y - area.y - CARINHA.h) / Math.max(1, area.height - CARINHA.h);
  relativo = { fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) };
  salvarEstado({ relativo });
}

/** O canto de baixo à direita da janela da bolha — onde a carinha mora. */
function cantoInicial() {
  const salvo = lerEstado();
  if (salvo.relativo && Number.isFinite(salvo.relativo.fx)) relativo = salvo.relativo;
  if (typeof salvo.passear === 'boolean') passear = salvo.passear;
  if (typeof salvo.ouvir === 'boolean') ouvir = salvo.ouvir;
  return cantoNo(screen.getPrimaryDisplay().workArea);
}

function dentro(p, a) {
  return p.x > a.x && p.x <= a.x + a.width && p.y > a.y && p.y <= a.y + a.height;
}

function cantoAtual() {
  return canto ?? cantoInicial();
}

/** Muda o tamanho da bolha sem a carinha sair do lugar (e sem a janela passar da tela). */
function aplicarModo(modo) {
  if (!bolha) return;
  const canto = cantoAtual();
  const t = modo === 'balao' ? BALAO : CARINHA;
  const area = screen.getDisplayNearestPoint(canto).workArea;
  const x = Math.max(area.x, canto.x - t.w);
  const y = Math.max(area.y, canto.y - t.h);
  posicionadoEm = Date.now();
  bolha.setBounds({ x, y, width: t.w, height: t.h });
  modoBolha = modo;
}

function criarBolha() {
  canto = cantoInicial();
  bolha = new BrowserWindow({
    x: canto.x - CARINHA.w,
    y: canto.y - CARINHA.h,
    width: CARINHA.w,
    height: CARINHA.h,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // resizable: false no Linux trava o tamanho (mínimo = máximo) e aí o balão não conseguia
    // abrir. Sem moldura, ninguém puxa a borda mesmo: quem muda o tamanho é aplicarModo().
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: 'Miro',
    icon: ICONE,
    webPreferences: webPrefs(),
  });
  bolha.setAlwaysOnTop(true, 'floating');
  bolha.setVisibleOnAllWorkspaces(true);
  protegerNavegacao(bolha);
  // O que a bolha registra sobre o "Miro, …" vai para o log do app (robo.log), para rastrear chamado perdido.
  bolha.webContents.on('console-message', (e, _nivel, texto) => {
    const msg = e?.message ?? texto;
    if (typeof msg === 'string' && msg.startsWith('[miro]')) console.log(`${new Date().toLocaleTimeString('pt-BR')} ${msg}`);
  });
  bolha.loadURL(`${BASE}/?desktop=bolha`);
  // Esconder (Super+K) tira a janela do mapa; ao voltar, o bspwm a trata como nova — com borda,
  // sem "fixa" e sem "por cima". Então os ajustes valem a cada vez que ela aparece.
  bolha.on('show', () => {
    setTimeout(async () => {
      if (!bolha) return;
      await ajustarNoBspwm(bolha, { sticky: true, semBorda: true });
      aplicarModo(modoBolha);
    }, 60);
  });
  bolha.once('ready-to-show', async () => {
    if (visivel) bolha.showInactive(); // aparece sem roubar o foco de quem está digitando
    await ajustarNoBspwm(bolha, { sticky: true, semBorda: true });
    aplicarModo(modoBolha); // o bspwm pode ter levado a janela para outro monitor: volta para o lugar
    // Moveu com Super+arrastar (o jeito do bspwm): a carinha passa a morar lá. Movimento logo
    // depois de o app posicionar é o bspwm levando a janela para o monitor em foco: desfaz.
    bolha.on('moved', () => {
      if (andando || Date.now() - posicionadoEm < 2000) {
        if (!andando) setTimeout(() => aplicarModo(modoBolha), 50);
        return;
      }
      const b = bolha.getBounds();
      canto = { x: b.x + b.width, y: b.y + b.height };
      arrastadaEm = Date.now();
      lembrarPosicao();
    });
    seguirMonitor();
    passearDeVezEmQuando();
  });
  bolha.on('closed', () => (bolha = null));
}

/* ── painel ──────────────────────────────────────────────────────────── */

/** O painel abre ao lado da carinha, no monitor dela. */
function lugarDoPainel() {
  const c = cantoAtual();
  const area = screen.getDisplayNearestPoint(c).workArea;
  const w = 420;
  const h = Math.min(760, area.height - 40);
  return { x: Math.max(area.x + 10, c.x - w - CARINHA.w), y: Math.max(area.y + 10, c.y - h), width: w, height: h };
}

function criarPainel() {
  const lugar = lugarDoPainel();
  painel = new BrowserWindow({
    ...lugar,
    minWidth: 340,
    minHeight: 420,
    show: false,
    title: 'Miro',
    icon: ICONE,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    webPreferences: webPrefs(),
  });
  protegerNavegacao(painel);
  // ROBO_K: entra já logado na primeira vez (a senha vai para o armazenamento do app e sai da URL).
  const k = process.env.ROBO_K ? `&k=${encodeURIComponent(process.env.ROBO_K)}` : '';
  painel.loadURL(`${BASE}/?desktop=painel${k}`);
  // O bspwm leva a janela flutuante nova para o monitor em foco: devolve para perto da carinha.
  painel.on('show', () => setTimeout(() => painel?.setBounds(lugarDoPainel()), 60));
  painel.once('ready-to-show', () => ajustarNoBspwm(painel, {}));
  // Fechar esconde: o painel guarda a conversa aberta e volta na hora.
  painel.webContents.on('did-start-loading', () => (painelPronto = false));
  painel.on('close', (e) => {
    if (app.saindo) return;
    e.preventDefault();
    fecharPainel();
  });
  painel.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      e.preventDefault();
      fecharPainel();
    }
  });
}

function abrirPainel() {
  if (!painel) criarPainel();
  painelAberto = true;
  if (visivel) {
    painel.show();
    painel.focus();
  }
  atualizarBandeja();
}

function fecharPainel() {
  painelAberto = false;
  painel?.hide();
  atualizarBandeja();
}

/* ── mostrar / esconder (atalho e bandeja) ───────────────────────────── */

function alternarVisivel() {
  visivel = !visivel;
  if (visivel) {
    bolha?.showInactive();
    if (painelAberto) painel?.show();
  } else {
    bolha?.hide();
    painel?.hide();
  }
  atualizarBandeja();
}

/* ── bspwm: janelas flutuantes, a bolha em todas as áreas e por cima ─── */

function bspc(args) {
  return new Promise((resolve) => execFile('bspc', args, (err) => resolve(!err)));
}

function idX11(win) {
  const buf = win.getNativeWindowHandle();
  return `0x${(buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0)).toString(16)}`;
}

/**
 * No bspwm toda janela nova vira ladrilho. A regra (só enquanto o app roda, sem mexer no
 * bspwmrc) faz as dele nascerem flutuantes; o resto é ajustado na própria janela.
 */
async function regrasBspwm() {
  // Tira as de execuções anteriores antes (senão elas se acumulam a cada vez que o app abre).
  await bspc(['rule', '-r', 'robo-desktop:*:*']);
  await bspc(['rule', '-a', 'robo-desktop', 'state=floating', 'focus=off', 'border=off']);
}

async function ajustarNoBspwm(win, { sticky = false, semBorda = false }) {
  const id = idX11(win);
  await bspc(['node', id, '-t', 'floating']);
  if (sticky) {
    await bspc(['node', id, '-g', 'sticky=on']);
    await bspc(['node', id, '-l', 'above']);
  }
  if (semBorda) await bspc(['config', '-n', id, 'border_width', '0']);
}

/* ── som do computador para a reunião (PipeWire) ─────────────────────── */

/*
 * O Chromium esconde as fontes "monitor" (o que sai no fone): não dá para gravar a chamada
 * direto. O jeito é uma fonte virtual que repete o que sai no fone, com cara de microfone comum:
 * um pw-loopback que captura a saída (stream.capture.sink) e a publica como Audio/Source.
 * (O module-remap-source do pipewire-pulse cria a fonte, mas muda; e com node.passive o
 * pw-loopback também fica mudo — testado em 24/09.) Nasce com a reunião e morre com ela.
 */
const SOM_NOME = 'robo_sistema';
const SOM_ROTULO = 'Robo-som-do-computador';
let loopback = null;

function comando(bin, args) {
  return new Promise((resolve) => execFile(bin, args, (err, out) => resolve(err ? null : String(out).trim())));
}

/* O PID fica num arquivo: se o app cair no meio de uma reunião, a próxima encerra o que sobrou
   (e só ele — um pkill por nome acertaria qualquer processo com esse texto na linha de comando). */
const LOOPBACK_PID = join(app.getPath('userData'), 'loopback.pid');

function soltarSomDoSistema() {
  loopback?.kill();
  loopback = null;
  try {
    const pid = Number(readFileSync(LOOPBACK_PID, 'utf8'));
    if (pid > 1) process.kill(pid);
  } catch {
    /* não havia sobra */
  }
  rmSync(LOOPBACK_PID, { force: true });
}

async function prepararSomDoSistema() {
  soltarSomDoSistema(); // inclusive a sobra de uma execução que caiu
  const saida = await comando('pactl', ['get-default-sink']); // a de agora (pode ter trocado de fone)
  loopback = spawn(
    'pw-loopback',
    [
      '-n',
      'robo-loopback',
      `--capture-props=stream.capture.sink=true${saida ? ` target.object=${saida}` : ''}`,
      `--playback-props=media.class=Audio/Source node.name=${SOM_NOME} node.description=${SOM_ROTULO}`,
    ],
    { stdio: 'ignore' },
  );
  loopback.on('error', () => (loopback = null));
  loopback.on('exit', () => (loopback = null));
  if (loopback.pid) writeFileSync(LOOPBACK_PID, String(loopback.pid));
  for (let i = 0; i < 15; i++) {
    if ((await comando('pactl', ['list', 'short', 'sources']))?.includes(SOM_NOME)) return SOM_ROTULO;
    await new Promise((r) => setTimeout(r, 200));
  }
  soltarSomDoSistema();
  return null;
}

ipcMain.handle('reuniao:som', () => prepararSomDoSistema());
ipcMain.on('reuniao:soltar-som', () => soltarSomDoSistema());
app.on('will-quit', () => soltarSomDoSistema());

/* ── "Miro, …": o ouvido (ouvinte.js) ────────────────────────────────── */

const ouvinte = new Ouvinte({
  pasta: join(app.getPath('userData'), 'ouvido'),
  aoCandidato: (c) => bolha?.webContents.send('ouvinte:candidato', c),
  aoEstado: (e) => {
    console.log(`[ouvido] ${e}`);
    bolha?.webContents.send('ouvinte:estado', e);
  },
});

/** Liga ou desliga a escuta: prepara os modelos (baixa na 1ª vez) e avisa a bolha para abrir o microfone. */
async function aplicarOuvir() {
  if (ouvir) {
    try {
      await ouvinte.preparar();
    } catch {
      bolha?.webContents.send('ouvinte:ligado', false);
      return;
    }
  }
  // ROBO_SEM_MICROFONE: o ouvido liga, mas a bolha não abre o microfone (teste com frases gravadas).
  bolha?.webContents.send('ouvinte:ligado', ouvir && !process.env.ROBO_SEM_MICROFONE);
  atualizarBandeja();
}

const DEBUG_OUVIDO = !!process.env.ROBO_DEBUG_OUVIDO;
let recebidas = 0;
ipcMain.on('ouvinte:audio', (_e, amostras) => {
  if (DEBUG_OUVIDO && recebidas++ % 50 === 0) console.log(`[ouvido] áudio: ${amostras?.constructor?.name} ${amostras?.length} (ouvir=${ouvir}, pronto=${ouvinte.pronto})`);
  if (ouvir && amostras instanceof Float32Array) ouvinte.alimentar(amostras);
});
ipcMain.on('ouvinte:nome', (_e, nome) => {
  if (typeof nome === 'string' && nome.trim()) {
    nomeDele = nome.trim();
    ouvinte.nome = nomeDele;
    atualizarBandeja();
  }
});
ipcMain.on('ouvinte:pronta', () => void aplicarOuvir()); // a bolha carregou: diz se é para ouvir
/* O botão de microfone do balão (e o "Miro, para de ouvir"): liga/desliga igual ao item da bandeja. */
ipcMain.on('ouvinte:alternar', (_e, sim) => {
  ouvir = typeof sim === 'boolean' ? sim : !ouvir;
  salvarEstado({ ouvir });
  void aplicarOuvir();
});

/*
 * Comandos que a bolha ouviu e que o painel executa (a reunião grava lá). Se o painel ainda não
 * existe, ele nasce escondido e recebe o comando quando o app dele terminar de carregar.
 */
let comandosPendentes = [];
let painelPronto = false;
ipcMain.on('painel:comando', (_e, acao) => {
  if (typeof acao !== 'string') return;
  if (!painel) criarPainel();
  if (painelPronto) painel.webContents.send('comando', acao);
  else comandosPendentes.push(acao);
});
ipcMain.on('painel:pronto', () => {
  painelPronto = true;
  for (const a of comandosPendentes) painel?.webContents.send('comando', a);
  comandosPendentes = [];
});
ipcMain.on('esconder', () => visivel && alternarVisivel());

/* ── seguir o monitor em uso, andando ────────────────────────────────── */

function pararDeAndar() {
  clearInterval(andando);
  andando = null;
  bolha?.webContents.send('andando', null);
}

/** Anda da posição atual até `alvo`, com a carinha pulando e virada para onde vai. */
function andarAte(alvo, ritmo = TROCA) {
  if (!bolha) return;
  clearInterval(andando);
  const de = cantoAtual();
  const dist = Math.hypot(alvo.x - de.x, alvo.y - de.y);
  if (dist < 4) return;
  const dur = Math.min(ritmo.max, Math.max(ritmo.min, (dist / ritmo.px_s) * 1000));
  const t0 = Date.now();
  bolha.webContents.send('andando', alvo.x < de.x ? 'esquerda' : 'direita');
  andando = setInterval(() => {
    const p = Math.min(1, (Date.now() - t0) / dur);
    const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2; // acelera e freia
    canto = { x: Math.round(de.x + (alvo.x - de.x) * e), y: Math.round(de.y + (alvo.y - de.y) * e) };
    aplicarModo(modoBolha);
    if (p >= 1) {
      pararDeAndar();
      lembrarPosicao();
    }
  }, 16);
}

/** De tempos em tempos, se ninguém está mexendo com ela, dá uma volta pelo monitor em uso. */
function passearDeVezEmQuando() {
  const proxima = PASSEIO_A_CADA_MS.min + Math.random() * (PASSEIO_A_CADA_MS.max - PASSEIO_A_CADA_MS.min);
  setTimeout(async () => {
    const quieta = !passear || !visivel || ocupada || dormindo || andando || modoBolha !== 'carinha';
    if (!quieta && Date.now() - arrastadaEm > PARADO_DEPOIS_DE_ARRASTAR_MS) {
      const area = await monitorFocado();
      if (area) {
        // Um ponto qualquer, mas não longe demais de onde está: parece passeio, não teletransporte.
        const c = cantoAtual();
        const alcance = Math.min(area.width, area.height) * 0.45;
        const ang = Math.random() * Math.PI * 2;
        const x = Math.min(area.x + area.width - 8, Math.max(area.x + CARINHA.w + 8, c.x + Math.cos(ang) * alcance));
        const y = Math.min(area.y + area.height - 8, Math.max(area.y + CARINHA.h + 8, c.y + Math.sin(ang) * alcance));
        andarAte({ x: Math.round(x), y: Math.round(y) }, PASSEIO);
      }
    }
    passearDeVezEmQuando();
  }, proxima);
}

/** O monitor (área útil) que o bspwm diz estar em foco. */
function monitorFocado() {
  return new Promise((resolve) => {
    execFile('bspc', ['query', '-T', '-m', 'focused'], (err, out) => {
      if (err) return resolve(null);
      try {
        const r = JSON.parse(out).rectangle;
        const d = screen.getAllDisplays().find((x) => x.bounds.x === r.x && x.bounds.y === r.y) ?? screen.getDisplayNearestPoint({ x: r.x + 1, y: r.y + 1 });
        resolve(d.workArea);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Acompanha o monitor em uso: o bspwm avisa cada troca de área de trabalho em foco (inclusive
 * quando o mouse passa para o outro monitor) e a carinha vai andando até lá.
 */
function seguirMonitor() {
  let ultimo = '';
  let espera = null;
  const conferir = async () => {
    const area = await monitorFocado();
    if (!area || !bolha) return;
    const chave = `${area.x},${area.y}`;
    if (chave === ultimo) return;
    ultimo = chave;
    // Já está nesse monitor (você a levou até lá, ou clicou nela): não sai do lugar.
    if (dentro(cantoAtual(), area)) return;
    // Dormindo não anda: fica onde está, e vai para o monitor em uso quando acordar.
    if (dormindo) {
      ultimo = '';
      return;
    }
    if (visivel) andarAte(cantoNo(area));
    else {
      canto = cantoNo(area); // escondido: aparece já no monitor certo
      aplicarModo(modoBolha);
    }
  };
  const sub = spawn('bspc', ['subscribe', 'desktop_focus'], { stdio: ['ignore', 'pipe', 'ignore'] });
  sub.stdout.on('data', () => {
    clearTimeout(espera);
    espera = setTimeout(conferir, 250); // várias trocas seguidas: anda uma vez só
  });
  sub.on('error', () => {}); // sem bspwm: fica parada onde está
  conferirMonitor = () => void conferir();
  app.on('will-quit', () => sub.kill());
  void conferir();
}

/* ── bandeja ─────────────────────────────────────────────────────────── */

function atualizarBandeja() {
  if (!bandeja) return;
  bandeja.setToolTip(ouvir ? `${nomeDele} (ouvindo)` : nomeDele);
  bandeja.setContextMenu(
    Menu.buildFromTemplate([
      { label: visivel ? `Esconder o ${nomeDele} (${ATALHO})` : `Mostrar o ${nomeDele} (${ATALHO})`, click: alternarVisivel },
      { label: painelAberto ? 'Fechar o painel' : 'Abrir o painel', click: () => (painelAberto ? fecharPainel() : abrirPainel()) },
      { type: 'separator' },
      {
        label: 'Falar em voz alta',
        type: 'checkbox',
        checked: vozLigada,
        click: (item) => {
          vozLigada = item.checked;
          bolha?.webContents.send('voz', vozLigada);
        },
      },
      {
        label: `Ouvir "${nomeDele}, …"`,
        type: 'checkbox',
        checked: ouvir,
        click: (item) => {
          ouvir = item.checked;
          salvarEstado({ ouvir });
          void aplicarOuvir();
        },
      },
      {
        label: 'Passear pela tela',
        type: 'checkbox',
        checked: passear,
        click: (item) => {
          passear = item.checked;
          salvarEstado({ passear });
          if (!passear && andando) pararDeAndar();
        },
      },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]),
  );
}

function criarBandeja() {
  bandeja = new Tray(ICONE_BANDEJA);
  bandeja.on('click', alternarVisivel);
  atualizarBandeja();
}

/* ── segurança: só o nosso servidor, e o microfone só para ele ───────── */

function webPrefs() {
  return {
    preload: join(AQUI, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    autoplayPolicy: 'no-user-gesture-required', // a voz dele toca sem precisar de clique
    backgroundThrottling: false, // escondido, continua recebendo as mensagens
  };
}

function protegerNavegacao(win) {
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== ORIGEM) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function permissoes() {
  const nossa = (url) => {
    try {
      return new URL(url).origin === ORIGEM;
    } catch {
      return false;
    }
  };
  const ok = ['media', 'notifications', 'clipboard-sanitized-write', 'clipboard-read'];
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(nossa(wc.getURL()) && ok.includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => !!wc && nossa(wc.getURL()) && ok.includes(perm));
}

/* ── o que a página pede (preload.cjs) ───────────────────────────────── */

ipcMain.on('bolha:modo', (_e, modo) => aplicarModo(modo === 'balao' ? 'balao' : 'carinha'));
ipcMain.on('bolha:mover', (_e, dx, dy) => {
  if (!bolha || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const c = cantoAtual();
  canto = { x: Math.round(c.x + dx), y: Math.round(c.y + dy) };
  aplicarModo(modoBolha);
});
ipcMain.on('bolha:soltar', () => {
  if (!bolha) return;
  arrastadaEm = Date.now(); // você a pôs ali: ela fica um tempo sem passear
  lembrarPosicao();
});
ipcMain.on('bolha:dormindo', (_e, sim) => {
  const antes = dormindo;
  dormindo = !!sim;
  if (dormindo && andando) pararDeAndar();
  if (antes && !dormindo) conferirMonitor(); // acordou: vai até o monitor em uso
});
ipcMain.on('bolha:ocupada', (_e, sim) => {
  ocupada = !!sim;
  if (ocupada && andando) pararDeAndar();
});
// Abriu o balão pelo clique: a janela precisa do foco para você digitar.
ipcMain.on('bolha:focar', () => bolha?.focus());
ipcMain.on('painel', (_e, acao) => {
  if (acao === 'fechar' || (acao === 'alternar' && painelAberto)) fecharPainel();
  else abrirPainel();
});
ipcMain.on('voz', (_e, ligada) => {
  vozLigada = !!ligada;
  atualizarBandeja();
});

/* ── ciclo de vida ───────────────────────────────────────────────────── */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!visivel) alternarVisivel();
  });
  app.whenReady().then(async () => {
    permissoes();
    await regrasBspwm();
    criarBolha();
    if (process.env.ROBO_K) criarPainel(); // primeira vez com a senha: o painel grava o login (fica escondido)
    criarBandeja();
    if (!globalShortcut.register(ATALHO, alternarVisivel)) console.error(`[robo] o atalho ${ATALHO} já está em uso`);
    app.on('before-quit', () => (app.saindo = true));
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Fechar janelas não encerra: ele vive na bandeja até você mandar sair.
  app.on('window-all-closed', () => {});
}
