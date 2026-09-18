/*
 * GERADO por packages/protocol/scripts/gen-c-header.ts — NÃO EDITE.
 * Rode `pnpm gen:c` na raiz depois de mudar packages/protocol.
 */
#pragma once

#include <string.h>

#define ROBO_PROTOCOL "robo-ws/1"

#define ROBO_AGENDA_MAX_ITEMS 8
#define ROBO_TITLE_MAX_BYTES 63
#define ROBO_SUB_MAX_BYTES 31
#define ROBO_ID_MAX_BYTES 23
#define ROBO_PREVIEW_MAX_BYTES 47
#define ROBO_SAY_MAX_BYTES 63

/* Device → Servidor */
#define ROBO_MSG_HELLO "hello"
#define ROBO_MSG_PING "ping"
#define ROBO_MSG_BUTTON "button"
#define ROBO_MSG_BATTERY "battery"
#define ROBO_MSG_ERROR "error"
#define ROBO_MSG_FACE "face"

/* Servidor → Device */
#define ROBO_MSG_HELLO_ACK "hello_ack"
#define ROBO_MSG_PONG "pong"
#define ROBO_MSG_STATE "state"
#define ROBO_MSG_DISPLAY "display"
#define ROBO_MSG_AGENDA "agenda"
#define ROBO_MSG_CHAT "chat"
#define ROBO_MSG_REACT "react"
#define ROBO_MSG_SAY "say"
#define ROBO_MSG_CLAUDE_USAGE "claude_usage"
#define ROBO_MSG_MUSIC "music"

typedef enum {
    ROBO_STATE_IDLE,
    ROBO_STATE_LISTENING,
    ROBO_STATE_THINKING,
    ROBO_STATE_SPEAKING,
    ROBO_STATE_MEETING,
    ROBO_STATE_ALERT,
    ROBO_STATE_ERROR,
    ROBO_STATE__COUNT
} robo_state_t;

static inline const char *robo_state_name(robo_state_t v)
{
    static const char *const names[] = { "idle", "listening", "thinking", "speaking", "meeting", "alert", "error" };
    return (unsigned)v < ROBO_STATE__COUNT ? names[v] : "?";
}

/* Retorna -1 se o nome não existir. */
static inline int robo_state_from_name(const char *s)
{
    for (int i = 0; i < ROBO_STATE__COUNT; i++) {
        if (strcmp(s, robo_state_name((robo_state_t)i)) == 0) return i;
    }
    return -1;
}

typedef enum {
    ROBO_BTN_BOOT,
    ROBO_BTN_KEY1,
    ROBO_BTN_KEY2,
    ROBO_BTN__COUNT
} robo_btn_t;

static inline const char *robo_btn_name(robo_btn_t v)
{
    static const char *const names[] = { "boot", "key1", "key2" };
    return (unsigned)v < ROBO_BTN__COUNT ? names[v] : "?";
}

/* Retorna -1 se o nome não existir. */
static inline int robo_btn_from_name(const char *s)
{
    for (int i = 0; i < ROBO_BTN__COUNT; i++) {
        if (strcmp(s, robo_btn_name((robo_btn_t)i)) == 0) return i;
    }
    return -1;
}

typedef enum {
    ROBO_BTN_EV_SHORT,
    ROBO_BTN_EV_LONG,
    ROBO_BTN_EV__COUNT
} robo_btn_ev_t;

static inline const char *robo_btn_ev_name(robo_btn_ev_t v)
{
    static const char *const names[] = { "short", "long" };
    return (unsigned)v < ROBO_BTN_EV__COUNT ? names[v] : "?";
}

/* Retorna -1 se o nome não existir. */
static inline int robo_btn_ev_from_name(const char *s)
{
    for (int i = 0; i < ROBO_BTN_EV__COUNT; i++) {
        if (strcmp(s, robo_btn_ev_name((robo_btn_ev_t)i)) == 0) return i;
    }
    return -1;
}

typedef enum {
    ROBO_DISPLAY_ALERT,
    ROBO_DISPLAY__COUNT
} robo_display_t;

static inline const char *robo_display_name(robo_display_t v)
{
    static const char *const names[] = { "alert" };
    return (unsigned)v < ROBO_DISPLAY__COUNT ? names[v] : "?";
}

/* Retorna -1 se o nome não existir. */
static inline int robo_display_from_name(const char *s)
{
    for (int i = 0; i < ROBO_DISPLAY__COUNT; i++) {
        if (strcmp(s, robo_display_name((robo_display_t)i)) == 0) return i;
    }
    return -1;
}

typedef enum {
    ROBO_FACE_NEUTRAL,
    ROBO_FACE_HAPPY,
    ROBO_FACE_LOVE,
    ROBO_FACE_SLEEPY,
    ROBO_FACE_SLEEPING,
    ROBO_FACE_WORRIED,
    ROBO_FACE_SURPRISED,
    ROBO_FACE_SAD,
    ROBO_FACE_ERROR,
    ROBO_FACE_THINKING,
    ROBO_FACE_BORED,
    ROBO_FACE_JAMMING,
    ROBO_FACE__COUNT
} robo_face_t;

static inline const char *robo_face_name(robo_face_t v)
{
    static const char *const names[] = { "neutral", "happy", "love", "sleepy", "sleeping", "worried", "surprised", "sad", "error", "thinking", "bored", "jamming" };
    return (unsigned)v < ROBO_FACE__COUNT ? names[v] : "?";
}

/* Retorna -1 se o nome não existir. */
static inline int robo_face_from_name(const char *s)
{
    for (int i = 0; i < ROBO_FACE__COUNT; i++) {
        if (strcmp(s, robo_face_name((robo_face_t)i)) == 0) return i;
    }
    return -1;
}
