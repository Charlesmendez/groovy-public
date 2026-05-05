FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.mjs ./
RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app

ENV PORT=8080
EXPOSE 8080

USER app
CMD ["node", "server.mjs"]
