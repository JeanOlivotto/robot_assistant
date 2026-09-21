/* Rostinho procedural: expressões com parâmetros interpolados, piscada e olhar vivo. */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Mesma ordem de FACES em packages/protocol (robo_face_t) — face.c confere na compilação. */
typedef enum {
    FACE_NEUTRAL,
    FACE_HAPPY,
    FACE_LOVE,
    FACE_SLEEPY,
    FACE_SLEEPING,
    FACE_WORRIED,
    FACE_SURPRISED,
    FACE_SAD,
    FACE_ERROR,
    FACE_THINKING,
    FACE_BORED,
    FACE_JAMMING,
    FACE_ANGRY,
    FACE__COUNT
} face_expr_t;

void face_init(void);
/* Troca de expressão acontece no meio de uma piscada, para não "pular". */
void face_set(face_expr_t e);
face_expr_t face_get(void);
const char *face_name(face_expr_t e);

/* Modo hacker: o rosto inteiro passa a ser desenhado em vermelho, seja qual for a expressão. */
void face_set_hacker(bool on);
bool face_hacker(void);

/* Olha para (dx, dy) — deslocamento do olhar em px — até until_ms (ex.: seguir a bolinha). */
void face_look_at(int dx, int dy, uint32_t until_ms);

/* Avança a animação e desenha o rosto com os olhos centrados em (cx, cy). */
void face_draw(int cx, int cy, uint32_t now_ms);
