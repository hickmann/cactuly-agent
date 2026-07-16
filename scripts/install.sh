#!/usr/bin/env bash
# Cactuly agent installer.
# Baixa docker-compose.yml + .env.example, gera POSTGRES_PASSWORD, e sobe o compose.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/hickmann/cactuly-agent/main/scripts/install.sh)
#
# Precisa de: docker (com compose plugin), curl, openssl.

set -euo pipefail

RAW="https://raw.githubusercontent.com/hickmann/cactuly-agent/main"
DEST="${CACTULY_AGENT_DIR:-$HOME/cactuly-agent}"

command -v docker >/dev/null 2>&1 || { echo "docker não encontrado. Instale antes: https://docs.docker.com/engine/install/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin não encontrado."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl não encontrado."; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl não encontrado."; exit 1; }

mkdir -p "$DEST"
cd "$DEST"

echo "→ Baixando docker-compose.yml e .env.example em $DEST"
curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml
curl -fsSL "$RAW/.env.example" -o .env.example

if [ -f .env ]; then
  echo "→ .env já existe — não sobrescrevendo. Verifique as variáveis manualmente."
else
  cp .env.example .env
  PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
  # gera SED cross-platform (GNU vs BSD)
  if sed --version >/dev/null 2>&1; then
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PASS|" .env
  else
    sed -i '' "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PASS|" .env
  fi
  echo "→ .env criado com POSTGRES_PASSWORD gerado."
  echo ""
  echo "‼️  Antes de subir, edite .env e cole CACTULY_ENROLLMENT_TOKEN"
  echo "   (gere em https://cactuly-portal.atlasberg.workers.dev/admin > Agents > Novo agent)"
  echo ""
  echo "   Quando estiver pronto:"
  echo "     cd $DEST && docker compose up -d && docker compose logs -f agent-runtime"
  exit 0
fi

echo "→ .env pronto. Subindo containers..."
docker compose pull
docker compose up -d
sleep 2
docker compose ps
