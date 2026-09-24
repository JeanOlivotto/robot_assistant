# Vozes: Debian (glibc) porque o binário pronto do sherpa-onnx não roda no Alpine do gateway.
FROM node:24-bookworm-slim
WORKDIR /app

# Modelos dentro da imagem: nada é baixado quando o container sobe.
ARG REL=https://github.com/k2-fsa/sherpa-onnx/releases/download
RUN apt-get update && apt-get install -y --no-install-recommends curl bzip2 ca-certificates \
 && mkdir -p /models && cd /tmp \
 && curl -fsSL $REL/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 | tar xj \
 && mv sherpa-onnx-pyannote-segmentation-3-0/model.onnx /models/segmentation.onnx \
 && curl -fsSL -o /models/embedding.onnx $REL/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx \
 && rm -rf /tmp/* && apt-get purge -y curl bzip2 && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src

ENV VOZES_MODELS=/models NODE_ENV=production
USER node
EXPOSE 8090
CMD ["node", "src/main.js"]
