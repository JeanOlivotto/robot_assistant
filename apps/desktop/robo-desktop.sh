#!/usr/bin/env sh
# Abre o robô flutuante. Chamado pelo bspwmrc ao entrar na sessão (o dex não está instalado,
# então ~/.config/autostart não funciona aqui). Se já estiver aberto, o Electron só mostra a janela.
DIR="$(cd "$(dirname "$0")" && pwd)"
# O log (o que o ouvido do "Miro, …" pegou, erros) começa do zero a cada abertura.
LOG="${XDG_CONFIG_HOME:-$HOME/.config}/robo-desktop/robo.log"
mkdir -p "$(dirname "$LOG")"
exec "$DIR/node_modules/electron/dist/electron" "$DIR" "$@" >"$LOG" 2>&1
