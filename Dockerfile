FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Install poppler-utils for pdftotext (used to parse CoreLogic suburb report PDFs)
RUN apt-get update && apt-get install -y poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

# Create downloads directory for temporary PDF storage
RUN mkdir -p downloads

EXPOSE 3000

CMD ["node", "server.js"]
