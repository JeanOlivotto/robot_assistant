/*
 * A ponte entre a página (o app web) e o Electron: só estas funções, nada de Node na página.
 * O app web usa isso em lib/desktop.ts; fora do Electron, `window.roboDesktop` não existe.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('roboDesktop', {
  modo: (m) => ipcRenderer.send('bolha:modo', m),
  mover: (dx, dy) => ipcRenderer.send('bolha:mover', dx, dy),
  soltar: () => ipcRenderer.send('bolha:soltar'),
  painel: (acao) => ipcRenderer.send('painel', acao),
  /** Balão aberto ou mouse em cima: o app não a leva para passear. */
  ocupada: (sim) => ipcRenderer.send('bolha:ocupada', !!sim),
  /** Pede o foco do teclado para a janela (para digitar no balão). */
  focar: () => ipcRenderer.send('bolha:focar'),
  vozMudou: (ligada) => ipcRenderer.send('voz', ligada),
  aoMudarVoz: (cb) => ipcRenderer.on('voz', (_e, ligada) => cb(!!ligada)),
  /** A carinha está andando para outro monitor ('esquerda' | 'direita'), ou parou (null). */
  aoAndar: (cb) => ipcRenderer.on('andando', (_e, lado) => cb(lado === 'esquerda' || lado === 'direita' ? lado : null)),
});
