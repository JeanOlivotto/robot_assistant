#!/usr/bin/env bash
# Roda na VPS depois que o GitHub Actions sincronizou o código em /opt/robo.
# Dá para rodar à mão também: ssh root@VPS 'bash /opt/robo/deploy/deploy.sh'
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "falta /opt/robo/.env — ver DEPLOY.md" >&2
  exit 1
fi
mkdir -p secrets
# Commit que o Actions acabou de enviar (deploy à mão sem o arquivo = "manual").
GIT_SHA="$(cat REVISION 2>/dev/null || echo manual)"
export GIT_SHA

docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
docker image prune -f > /dev/null

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/health > /dev/null; then
    echo "robo-gateway no ar"
    exit 0
  fi
  sleep 2
done

echo "o gateway não respondeu em 60 s" >&2
docker compose -f docker-compose.prod.yml logs --tail 80 gateway >&2
exit 1
