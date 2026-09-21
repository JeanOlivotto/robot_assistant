/* Cliente do protocolo robo-ws/1 (seção 7 do doc) — só a parte de controle em JSON por enquanto. */
#pragma once

#include "protocol.h"

void ws_client_start(void);
void ws_client_send_button(robo_btn_t id, robo_btn_ev_t ev);
/* Conta ao servidor qual expressão a tela está mostrando (o webapp espelha). */
void ws_client_send_face(robo_face_t face);
/* Como vai a atualização de firmware (o servidor acompanha e registra). */
void ws_client_send_ota_status(robo_ota_phase_t phase, int pct, const char *version, const char *detail);
