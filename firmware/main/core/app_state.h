/* Estado compartilhado entre a rede (escreve) e a UI (lê um snapshot por quadro). */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "protocol.h"

typedef struct {
    char id[ROBO_ID_MAX_BYTES + 1];
    char title[ROBO_TITLE_MAX_BYTES + 1];
    int64_t start_ms;
    int64_t end_ms;
    bool all_day;
} agenda_item_t;

typedef struct {
    char id[ROBO_ID_MAX_BYTES + 1];
    char title[ROBO_TITLE_MAX_BYTES + 1];
    char sub[ROBO_SUB_MAX_BYTES + 1];
    int64_t at_ms; /* 0 = sem horário */
    uint32_t ttl_ms;
} alert_t;

/* Conversa com o dono pelo app (mensagem `chat` do protocolo). */
typedef struct {
    bool thinking;
    int64_t waiting_since_ms; /* 0 = não está esperando resposta */
    char preview[ROBO_PREVIEW_MAX_BYTES + 1];
} chat_state_t;

typedef struct {
    bool wifi_up;
    bool server_up;
    int n_agenda;
    agenda_item_t agenda[ROBO_AGENDA_MAX_ITEMS];
    bool has_alert; /* alerta novo desde o último snapshot */
    alert_t alert;
    chat_state_t chat;
    bool has_react; /* reação nova desde o último snapshot */
    robo_face_t react_face;
    uint32_t react_ms;
} app_snapshot_t;

void app_state_init(void);
void app_set_wifi(bool up);
void app_set_server(bool up);
void app_set_agenda(const agenda_item_t *items, int n);
void app_push_alert(const alert_t *a);
void app_set_chat(const chat_state_t *c);
void app_push_react(robo_face_t face, uint32_t ms);

/* Copia o estado para `out` e consome o alerta pendente. */
void app_snapshot(app_snapshot_t *out);
