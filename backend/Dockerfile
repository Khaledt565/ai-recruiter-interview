# Dockerfile for Fargate deployment

FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Copy SSL certificates
COPY certs/ ./certs/

# Expose port
EXPOSE 8080

# Health check (HTTPS)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const https = require('https'); const fs = require('fs'); const opts = {rejectUnauthorized: false}; https.get('https://localhost:8080/health', opts, (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1))"

# Start server
CMD ["node", "src/server.js"]
