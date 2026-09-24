#!/usr/bin/env sh
# Abre o robô flutuante. Chamado pelo bspwmrc ao entrar na sessão (o dex não está instalado,
# então ~/.config/autostart não funciona aqui). Se já estiver aberto, o Electron só mostra a janela.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/node_modules/electron/dist/electron" "$DIR" "$@" >/dev/null 2>&1
