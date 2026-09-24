/* Stub para compilar face.c no computador: sorteio fixo, para a imagem sair sempre igual. */
#pragma once
#include <stdint.h>
static inline uint32_t esp_random(void) { static uint32_t x = 12345; x = x * 1103515245u + 12345u; return x >> 8; }
