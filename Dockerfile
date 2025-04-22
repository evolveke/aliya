FROM node:18
WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install
COPY . .
CMD ["node", "index.js"]