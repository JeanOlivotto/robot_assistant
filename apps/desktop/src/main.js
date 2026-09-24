/*
 * O robô no computador. Duas janelas carregam o mesmo app web do servidor (cada deploy já
 * atualiza o desktop, sem reinstalar):
 *   - a BOLHA: a carinha redonda, sem moldura, transparente, sempre por cima e em todas as áreas
 *     de trabalho; cresce para mostrar o balão quando ele fala;
 *   - o PAINEL: o app inteiro (chat, agenda, pendências, reunião) numa janela, aberto pela bolha.
 * O Electron só faz o que o navegador não faz: janela flutuante, bandeja, atalho global
 * (Super+Shift+R — o Super+R do sxhkd gira a área de trabalho), iniciar com o sistema.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Menu, Tray, app, globalShortcut, ipcMain, screen, session, shell } from 'electron';

const AQUI = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.ROBO_URL || 'https://srv1966497.hstgr.cloud').replace(/\/+$/, '');
const ORIGEM = new URL(BASE).origin;
const ATALHO = process.env.ROBO_ATALHO || 'Super+Shift+R';
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

/** O canto de baixo à direita da janela da bolha — onde a carinha mora. */
function cantoInicial() {
  const salvo = lerEstado().canto;
  const area = screen.getPrimaryDisplay().workArea;
  if (salvo && screen.getAllDisplays().some((d) => dentro(salvo, d.workArea))) return salvo;
  return { x: area.x + area.width - MARGEM, y: area.y + area.height - MARGEM };
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
    title: 'Robô',
    icon: ICONE,
    webPreferences: webPrefs(),
  });
  bolha.setAlwaysOnTop(true, 'floating');
  bolha.setVisibleOnAllWorkspaces(true);
  protegerNavegacao(bolha);
  bolha.loadURL(`${BASE}/?desktop=bolha`);
  bolha.once('ready-to-show', async () => {
    if (visivel) bolha.showInactive(); // aparece sem roubar o foco de quem está digitando
    await ajustarNoBspwm(bolha, { sticky: true, semBorda: true });
    aplicarModo(modoBolha); // o bspwm pode ter levado a janela para outro monitor: volta para o lugar
    // Moveu com Super+arrastar (o jeito do bspwm): a carinha passa a morar lá.
    bolha.on('moved', () => {
      const b = bolha.getBounds();
      canto = { x: b.x + b.width, y: b.y + b.height };
      salvarEstado({ canto });
    });
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
    title: 'Robô',
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
  await bspc(['rule', '-a', 'robo-desktop', 'state=floating', 'focus=off']);
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

/* ── bandeja ─────────────────────────────────────────────────────────── */

const AUTOSTART = join(homedir(), '.config/autostart/robo-desktop.desktop');

function iniciaComSistema() {
  try {
    readFileSync(AUTOSTART);
    return true;
  } catch {
    return false;
  }
}

/** ~/.config/autostart: o dex do bspwmrc abre o que estiver lá quando você entra. */
function definirAutostart(ligado) {
  if (!ligado) {
    rmSync(AUTOSTART, { force: true });
    return;
  }
  const exec = app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`;
  mkdirSync(dirname(AUTOSTART), { recursive: true });
  writeFileSync(
    AUTOSTART,
    ['[Desktop Entry]', 'Type=Application', 'Name=Robô', 'Comment=O robô flutuante', `Exec=${exec}`, `Icon=${ICONE}`, 'X-GNOME-Autostart-enabled=true', ''].join(
      '\n',
    ),
  );
}

function atualizarBandeja() {
  if (!bandeja) return;
  bandeja.setContextMenu(
    Menu.buildFromTemplate([
      { label: visivel ? `Esconder o robô (${ATALHO})` : `Mostrar o robô (${ATALHO})`, click: alternarVisivel },
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
        label: 'Iniciar com o sistema',
        type: 'checkbox',
        checked: iniciaComSistema(),
        click: (item) => definirAutostart(item.checked),
      },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]),
  );
}

function criarBandeja() {
  bandeja = new Tray(ICONE_BANDEJA);
  bandeja.setToolTip('Robô');
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
ipcMain.on('bolha:soltar', () => bolha && salvarEstado({ canto: cantoAtual() }));
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
