#!/usr/bin/env bash
# O Miro desta máquina pela polybar: ligado, desligado — e desligado continua desligado no próximo login.
#
#   miro-polybar.sh --bar     ícone da barra
#   miro-polybar.sh toggle    desliga na hora; para ligar, pede a senha do Miro (rofi)
#   miro-polybar.sh senha     troca a senha (pede a atual, se já tiver uma)
#
# Desligado, o app não abre (nem pelo bspwmrc): sem carinha, sem microfone e sem braço — o servidor
# vê o computador como desconectado e não mexe em nada aqui. A senha fica só como hash (SHA-512 crypt).
DIR="$(cd "$(dirname "$0")" && pwd)"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/robo-desktop"
DESLIGADO="$CFG/desligado"
SENHA="$CFG/senha"
mkdir -p "$CFG"

# O processo principal do Electron (o Chromium reordena os argumentos: os filhos têm --type=).
principal() { pgrep -af electron/dist/electron | grep -v -- --type= | grep -F "$DIR" | awk '{print $1}'; }
avisar() { notify-send -a Miro "Miro" "$1" 2>/dev/null; }
perguntar() { rofi -dmenu -password -p "$1" -lines 0 </dev/null 2>/dev/null; }
hash() { openssl passwd -6 -salt "$1" -stdin <<<"$2"; }

confere() {
  local salt
  salt="$(cut -d'$' -f3 "$SENHA")"
  [[ "$(hash "$salt" "$1")" == "$(cat "$SENHA")" ]]
}

definir_senha() {
  local nova repete
  nova="$(perguntar 'Nova senha do Miro')" || return 1
  [[ ${#nova} -ge 4 ]] || { avisar 'Senha curta demais (mínimo 4).'; return 1; }
  repete="$(perguntar 'Repita a senha')" || return 1
  [[ "$nova" == "$repete" ]] || { avisar 'As senhas não batem.'; return 1; }
  (umask 077; hash "$(openssl rand -hex 8)" "$nova" >"$SENHA")
  avisar 'Senha do Miro definida.'
}

case "$1" in
  --bar)
    if [[ -n "$(principal)" ]]; then echo -e "%{F#86d8e0}%{T5}\ue900%{T-}%{F-}"
    else echo -e "%{F#6f8589}%{T5}\ue901%{T-}%{F-}"; fi
    ;;
  toggle)
    pid="$(principal)"
    if [[ -n "$pid" ]]; then
      touch "$DESLIGADO"
      kill -TERM $pid # o app solta o braço e o microfone ao sair
      avisar 'Desligado nesta máquina. Para ligar de novo, clique e digite a senha.'
      exit 0
    fi
    if [[ ! -s "$SENHA" ]]; then
      definir_senha || exit 0
    else
      tentativa="$(perguntar 'Senha do Miro')" || exit 0
      confere "$tentativa" || { avisar 'Senha errada — continua desligado.'; exit 0; }
    fi
    rm -f "$DESLIGADO"
    setsid -f "$DIR/robo-desktop.sh" >/dev/null 2>&1
    avisar 'Ligado.'
    ;;
  senha)
    if [[ -s "$SENHA" ]]; then
      atual="$(perguntar 'Senha atual do Miro')" || exit 0
      confere "$atual" || { avisar 'Senha errada.'; exit 0; }
    fi
    definir_senha
    ;;
  *) echo "uso: $0 --bar | toggle | senha" >&2; exit 1 ;;
esac
