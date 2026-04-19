FROM node:20-bookworm-slim

# deps de Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 \
    libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxkbcommon0 libxrandr2 wget xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# instala chromium de playwright en imagen
RUN npx playwright install chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
