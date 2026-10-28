FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY sql ./sql
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.js"]
