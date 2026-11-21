FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10.34.9
COPY . .
RUN pnpm install --frozen-lockfile && pnpm run build:render

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build /app/artifacts ./artifacts
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
EXPOSE 8080
CMD ["node", "artifacts/api-server/dist/index.mjs"]
