FROM node:22

WORKDIR /tools
COPY package*.json ./
RUN npm install --python=python3
COPY . .
CMD ["node", "index.js"]