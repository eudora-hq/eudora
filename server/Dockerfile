FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy shared constants (outside server directory)
COPY shared/ /shared/

# Copy server files
COPY server/package*.json ./
RUN npm install

COPY server/ .

EXPOSE 3001

CMD ["node", "src/index.js"]
