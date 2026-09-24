/* Ícones pequenos da barra de status, desenhados à mão (sem sprites). */
#pragma once

#include <stdbool.h>

/* Runa do Bluetooth, 7×11 px com o topo em (x, y). near: o iPhone do dono está perto (azul);
 * senão, o Bluetooth está ouvindo mas ninguém por perto (apagado). */
void icon_bluetooth(int x, int y, bool near);
