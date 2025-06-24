# Stage 1: Build React app
FROM node:18-alpine AS builder

WORKDIR /app
COPY ../frontend/package*.json ./
COPY ../frontend ./

RUN npm install && npm run build

# Stage 2: Nginx with React frontend
FROM nginx:alpine

# Copy React build
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy custom nginx config and certs
COPY ./nginx/nginx.conf /etc/nginx/nginx.conf

# The certs are mounted via docker-compose
EXPOSE 8443

CMD ["nginx", "-g", "daemon off;"]
