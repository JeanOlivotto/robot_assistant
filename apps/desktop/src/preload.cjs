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
  vozMudou: (ligada) => ipcRenderer.send('voz', ligada),
  aoMudarVoz: (cb) => ipcRenderer.on('voz', (_e, ligada) => cb(!!ligada)),
});
