# Debian-based image supplies Poppler and Tesseract from distribution packages.
# OCR remains opt-in through AP_PDF_OCR_ENABLED=true.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && command -v tesseract \
    && command -v pdftoppm

WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => {if (r.statusCode !== 200) process.exit(1)}).on('error',()=>process.exit(1))"
CMD ["npm", "start"]
