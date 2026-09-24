/* Modo música: a tela inteira enquanto o Spotify toca. Só desenha — quem decide quando é o ui.c. */
#pragma once

#include <stdint.h>

/* hhmm vazio = relógio ainda sem hora. title/artist podem vir vazios. */
void music_view_draw(uint32_t now, const char *hhmm, const char *title, const char *artist);
