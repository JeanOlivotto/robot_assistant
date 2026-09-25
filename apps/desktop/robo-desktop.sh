#!/usr/bin/env sh
# Abre o robô flutuante. Chamado pelo bspwmrc ao entrar na sessão (o dex não está instalado,
# então ~/.config/autostart não funciona aqui). Se já estiver aberto, o Electron só mostra a janela.
DIR="$(cd "$(dirname "$0")" && pwd)"
# O log (o que o ouvido do "Miro, …" pegou, erros) continua de uma abertura para a outra — reabrir
# o app apagava justo as tentativas que eu queria olhar. Passou de 2 MB, guarda o antigo e começa outro.
LOG="${XDG_CONFIG_HOME:-$HOME/.config}/robo-desktop/robo.log"
mkdir -p "$(dirname "$LOG")"
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 2000000 ]; then mv -f "$LOG" "$LOG.1"; fi
echo "=== $(date '+%d/%m %H:%M:%S') abriu ===" >>"$LOG"
exec "$DIR/node_modules/electron/dist/electron" "$DIR" "$@" >>"$LOG" 2>&1
