# Minimalny obraz dla Node 20
FROM node:20-slim

# Ustaw katalog roboczy
WORKDIR /app

# Instaluj zależności (production)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

# Skopiuj resztę plików
COPY . .

ENV NODE_ENV=production
CMD ["npm", "start"]
