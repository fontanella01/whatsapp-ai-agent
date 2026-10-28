# One image with the API and the built web app.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build -w apps/web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# tsx (a runtime dependency of the API) runs the TypeScript directly, no compile step
RUN npm ci --omit=dev -w apps/api && npm cache clean --force
COPY apps/api apps/api
COPY --from=build /app/apps/web/dist apps/web/dist
WORKDIR /app/apps/api
ENV WEB_DIR=/app/apps/web/dist PORT=3333
EXPOSE 3333
USER node
CMD ["npx", "tsx", "src/server.ts"]
