/* A "vida" do robô quando ninguém está falando com ele: brincar de bolinha e pensar alto. */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "face.h"

typedef struct {
    bool online;          /* Wi-Fi + servidor */
    bool waiting;         /* mandou mensagem e espera resposta */
    bool clock_ok;
    int64_t wall_ms;
    const char *next_title; /* próximo compromisso de hoje (NULL se não há) */
    int64_t next_start_ms;
} life_ctx_t;

void life_init(uint32_t now);

/* Chamada por quadro quando a tela do rosto está livre. Recebe o humor-base e devolve o final
   (brincando de bolinha ele fica feliz). */
face_expr_t life_update(uint32_t now, face_expr_t mood, const life_ctx_t *ctx);
void life_stop(void);

void life_play_ball(uint32_t now, uint32_t ms);
bool life_playing(void);
void life_draw_ball(void);

/* Balão de fala */
void life_say(const char *text, uint32_t ms, uint32_t now);
void life_pet(uint32_t now);
const char *life_speech(uint32_t now); /* NULL se não está falando */
