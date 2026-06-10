# Atendente Cláudia (whatsapp-web.js) — imagem com Chromium do SO.
# Instalar o Chromium pelo apt evita o bundle quebrado do puppeteer.
FROM node:20-slim

# Chromium + libs/fontes que o WhatsApp Web precisa pra renderizar headless.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Sessão do WhatsApp Web. No Railway, monte um Volume (na UI) em /app/.wwebjs_auth —
# NÃO usar a instrução docker VOLUME (o builder do Railway rejeita; usa Railway Volumes).
# Sem o volume montado, todo redeploy desloga e exige re-scan do QR.
ENV WWEB_AUTH=/app/.wwebjs_auth

EXPOSE 3838
CMD ["node", "server.js"]
