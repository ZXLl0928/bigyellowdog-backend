FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p data
EXPOSE 3000
CMD ["node", "server.js"]
