# Deploy — VPS Hostinger (a mesma do 2fitspace)

```
                 internet
                     |
                 :80 :443
       nginx do HOST (TLS via certbot)
        |                         |
 2fitspace.com.br         srv1966497.hstgr.cloud
 127.0.0.1:3000           127.0.0.1:8080
 (fitspace-app)           (robo-gateway: API + webapp + WebSockets /device e /app)
```

O robô convive com o 2fitspace sem encostar nele: container, rede, volume e site
do nginx próprios. Nada do robô escuta fora do loopback.

| | |
|---|---|
| Servidor | `srv1966497.hstgr.cloud` / `2.25.127.107` (AlmaLinux 10, Docker, nginx no host) |
| Código | `/opt/robo` (sincronizado pelo Actions via rsync) |
| Segredos | `/opt/robo/.env` e `/opt/robo/secrets/` — nunca no git, o rsync não toca |
| Dados | volume `robo_robo-data` (histórico do chat, memória do robô) |
| Webapp | https://srv1966497.hstgr.cloud |
| Robô | `wss://srv1966497.hstgr.cloud/device` |

## Deploy automático

Todo push na `main` que mexe no servidor (fora `firmware/` e `*.md`) roda os testes,
builda gateway + webapp e, se passar, sincroniza o código e chama `deploy/deploy.sh`.

Segredos em **GitHub → Settings → Secrets and variables → Actions**:

| Secret | Valor |
|---|---|
| `VPS_HOST` | `2.25.127.107` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | conteúdo de `secrets/actions_deploy` (chave privada **só deste repo**) |

A pública (`secrets/actions_deploy.pub`) já está em `/root/.ssh/authorized_keys`.

## Montagem inicial (já feita — para refazer num servidor novo)

```bash
# 1. código (depois o Actions mantém sincronizado)
mkdir -p /opt/robo/secrets

# 2. segredos
umask 077 && vi /opt/robo/.env          # modelo: .env.example (tokens NOVOS, não os de dev)
cp google-sa.json /opt/robo/secrets/    # opcional: sem ele a agenda é só leitura

# 3. subir
bash /opt/robo/deploy/deploy.sh

# 4. nginx + TLS
cp /opt/robo/deploy/nginx-robo.conf /etc/nginx/conf.d/robo.conf
nginx -t && systemctl reload nginx
certbot --nginx -d srv1966497.hstgr.cloud --redirect
```

## Operação

```bash
cd /opt/robo
docker compose -f docker-compose.prod.yml logs -f gateway     # logs
docker compose -f docker-compose.prod.yml restart gateway     # reiniciar
bash deploy/deploy.sh                                          # deploy à mão
```

Mudou o `.env` ou a chave do Google? `docker compose -f docker-compose.prod.yml up -d`
(recria o container com o ambiente novo).

### Rollback

No GitHub, em **Actions → Deploy**, abra a execução do commit bom e clique em
**Re-run all jobs** — ela sincroniza aquele commit de novo.
