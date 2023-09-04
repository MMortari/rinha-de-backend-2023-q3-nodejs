FROM node:18.17.1-alpine

WORKDIR /app

COPY . .

RUN ls

CMD ["node", "./src/server.js"]