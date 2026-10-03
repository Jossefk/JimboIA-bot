FROM node:22-alpine

# Instalar dependencias para soporte de zonas horarias y decodificación de audio
RUN apk add --no-cache tzdata ffmpeg

ENV TZ=America/Caracas
ENV NODE_ENV=production

WORKDIR /app

# Copiar manifiestos primero para cachear capas de npm
COPY package*.json ./
RUN npm ci --only=production

# Copiar código fuente
COPY . .

# Directorio de datos para la base de datos persistente SQLite
RUN mkdir -p /app/data

# Declarar volumen para Coolify o Docker
VOLUME ["/app/data"]

CMD ["node", "index.js"]
