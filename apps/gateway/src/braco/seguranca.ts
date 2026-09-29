/**
 * Comando que pode rodar direto, sem o botão de aprovação: abrir programa, site, pasta, consultar.
 * O modelo diz se acha simples, e esta checagem confere por conta própria — qualquer coisa que
 * apague, instale, mande, mude o sistema ou encadeie outro shell vai para a aprovação.
 */
const PROIBIDOS = new RegExp(
  '(^|[\\s;&|(\'"`])(' +
    [
      // apagar, mover, sobrescrever
      'rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri', 'mv', 'move', 'move-item', 'cp', 'copy', 'copy-item', 'dd', 'mkfs\\S*',
      'format', 'truncate', 'shred', 'tee', 'set-content', 'add-content', 'out-file', 'new-item', 'ni', 'rename-item', 'ren',
      // desligar, matar, permissões, administrador
      'shutdown', 'reboot', 'poweroff', 'halt', 'kill', 'pkill', 'killall', 'taskkill', 'stop-process', 'sudo', 'su', 'doas',
      'runas', 'chmod', 'chown', 'chattr', 'setfacl', 'systemctl', 'service', 'sc', 'net', 'netsh', 'reg', 'set-itemproperty',
      'set-executionpolicy', 'crontab', 'schtasks',
      // instalar, baixar, rede, código
      'apt', 'apt-get', 'pacman', 'yay', 'dnf', 'snap', 'flatpak', 'pip', 'pip3', 'npm', 'npx', 'pnpm', 'yarn', 'winget', 'choco',
      'scoop', 'git', 'ssh', 'scp', 'rsync', 'curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'docker',
      'kubectl', 'python', 'python3', 'node', 'bash', 'sh', 'zsh', 'fish', 'powershell', 'pwsh', 'cmd', 'eval', 'exec',
      'invoke-expression', 'iex', 'source',
      // mandar mensagem
      'mail', 'sendmail', 'mutt', 'send-mailmessage', 'notify-send',
    ].join('|') +
    ')(?=$|[\\s;&|)\'"`])',
  'i',
);

/** Redirecionar para arquivo, substituir comando, encadear pipe: sempre com aprovação. */
const ENCADEAMENTO = /[<>`]|\$\(|\|/;

export function comandoSimples(cmd: string): boolean {
  const c = cmd.trim();
  if (!c || c.length > 300) return false;
  if (ENCADEAMENTO.test(c)) return false;
  return !PROIBIDOS.test(c);
}

/**
 * Arquivo que nunca sai do computador pelo WhatsApp, nem com o "sim" do dono: chave, senha, token.
 * O cartão mostra o caminho, mas um texto de terceiro pode induzir o modelo — esta trava não depende dele.
 */
const ARQUIVO_SENSIVEL =
  /(^|[\/\\])(\.ssh|\.gnupg|\.aws|\.kube|\.docker)([\/\\]|$)|(^|[\/\\])\.env(\.[^\/\\]*)?$|\.(pem|key|p12|pfx|kdbx|keystore|jks)$|(^|[\/\\])id_(rsa|dsa|ecdsa|ed25519)[^\/\\]*$|credentials|secrets?([\/\\.]|$)|\.netrc$|\.pgpass$|wallet\.dat$/i;

export function arquivoSensivel(caminho: string): boolean {
  return ARQUIVO_SENSIVEL.test(caminho.trim());
}

/**
 * Senha que entra no sudo pelo stdin (`echo 'senha' | sudo -S …`) não vai para o log: vira '***'.
 * O comando roda como veio; só o que fica escrito é mascarado.
 */
const SENHA_NO_SUDO = /\b((?:echo|printf)\s+)("[^"]*"|'[^']*'|[^\s|]+)(\s*\|\s*sudo\b)/gi;

export function semSenha(cmd: string): string {
  return cmd.replace(SENHA_NO_SUDO, "$1'***'$3");
}
