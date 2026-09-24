/* Stub para compilar gfx.c no computador. */
#pragma once
#include <stdlib.h>
#define MALLOC_CAP_DMA 0
#define MALLOC_CAP_INTERNAL 0
static inline void *heap_caps_calloc(size_t n, size_t size, int caps) { (void)caps; return calloc(n, size); }
