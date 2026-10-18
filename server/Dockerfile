# TokenTrace API — production image for Azure Container Apps.
# Migrations run automatically on boot (src/index.js calls migrate() before listen).
FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY migrations ./migrations

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["node", "src/index.js"]
