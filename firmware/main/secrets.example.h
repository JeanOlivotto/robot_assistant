/*
 * Copie para secrets.h (fica fora do git) e preencha.
 * O portal de configuração pelo celular substitui isto mais adiante (doc, seção 4.1).
 */
#pragma once

/*
 * Redes Wi-Fi em ordem de prioridade — o robô usa a primeira que estiver no ar e,
 * se ela cair (ou ficar sem internet), passa para a próxima. Só 2.4 GHz.
 */
#define ROBO_WIFI_NETWORKS                \
    {"rede-principal", "senha"},          \
    {"rede-reserva", "senha"},            \
    {"hotspot-do-celular", "senha"}

/* Servidor: a VPS por WebSocket com TLS, ou um gateway local ("ws://IP-DO-PC:8080") */
#define ROBO_SERVER_URL   "wss://srv1966497.hstgr.cloud"

/* Igual ao DEVICE_TOKEN do .env do servidor */
#define ROBO_DEVICE_TOKEN "troque-por-um-token-longo"

#define ROBO_DEVICE_NAME  "robo-01"
