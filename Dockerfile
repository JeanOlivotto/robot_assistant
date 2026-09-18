# Gateway (NestJS) + webapp (Vite) numa imagem só — o gateway serve o dist/ do webapp.
# Build na própria VPS, chamado por deploy/deploy.sh.

FROM node:24-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.4.2

# Dependências primeiro: muda pouco, então a camada fica em cache entre deploys.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages/protocol packages/protocol
COPY apps/gateway apps/gateway
COPY apps/web apps/web
RUN pnpm -r build


FROM node:24-alpine
# tzdata: datas de "dia inteiro" viram meia-noite em America/Sao_Paulo (TZ_NAME).
RUN apk add --no-cache tzdata
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/health > /dev/null || exit 1
CMD ["node", "apps/gateway/dist/main.js"]
