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
  /** O robô dormiu/acordou: dormindo, a carinha não passeia nem troca de monitor. */
  dormindo: (sim) => ipcRenderer.send('bolha:dormindo', !!sim),
  /** Reunião: cria a fonte "som do computador" (o que sai no fone) e devolve o nome dela. */
  somDoSistema: () => ipcRenderer.invoke('reuniao:som'),
  soltarSomDoSistema: () => ipcRenderer.send('reuniao:soltar-som'),
  /* "Miro, …": a bolha capta o microfone e manda o áudio; o ouvido (processo principal) devolve
     as frases candidatas para o servidor confirmar. */
  ouvintePronta: () => ipcRenderer.send('ouvinte:pronta'),
  ouvinteAudio: (amostras) => ipcRenderer.send('ouvinte:audio', amostras),
  ouvinteNome: (nome) => ipcRenderer.send('ouvinte:nome', nome),
  /** Por `ms`, a próxima fala vale como comando sem precisar do nome. */
  ouvinteAtento: (ms) => ipcRenderer.send('ouvinte:atento', Number(ms)),
  /** Liga/desliga a escuta (sem argumento: inverte). */
  ouvinteAlternar: (sim) => ipcRenderer.send('ouvinte:alternar', typeof sim === 'boolean' ? sim : undefined),
  aoOuvir: (cb) => ipcRenderer.on('ouvinte:ligado', (_e, sim) => cb(!!sim)),
  aoCandidato: (cb) => ipcRenderer.on('ouvinte:candidato', (_e, c) => cb(c)),
  aoOuvinteEstado: (cb) => ipcRenderer.on('ouvinte:estado', (_e, e) => cb(String(e))),
  /** Comando de voz para o painel ("reuniao:gravar", "reuniao:encerrar"). */
  comando: (acao) => ipcRenderer.send('painel:comando', acao),
  /** No painel: recebe os comandos (e avisa que está pronto para eles). */
  aoComando: (cb) => {
    ipcRenderer.on('comando', (_e, acao) => cb(String(acao)));
    ipcRenderer.send('painel:pronto');
  },
  esconder: () => ipcRenderer.send('esconder'),
  /** Depois do login: o braço (executar coisas no computador) entra no servidor com a mesma senha. */
  bracoToken: (token) => ipcRenderer.send('braco:token', String(token)),
  /** O nome deste computador: o pedido feito daqui roda aqui. */
  maquina: () => ipcRenderer.sendSync('maquina'),
  vozMudou: (ligada) => ipcRenderer.send('voz', ligada),
  aoMudarVoz: (cb) => ipcRenderer.on('voz', (_e, ligada) => cb(!!ligada)),
  /** A carinha está andando para outro monitor ('esquerda' | 'direita'), ou parou (null). */
  aoAndar: (cb) => ipcRenderer.on('andando', (_e, lado) => cb(lado === 'esquerda' || lado === 'direita' ? lado : null)),
});
