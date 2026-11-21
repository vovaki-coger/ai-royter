import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(cors({ credentials: true, origin: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const clerkPublishableKey =
  process.env.CLERK_PUBLISHABLE_KEY ??
  process.env.VITE_CLERK_PUBLISHABLE_KEY;
const clerkSecretKey = process.env.CLERK_SECRET_KEY;

if (clerkPublishableKey && clerkSecretKey) {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        clerkPublishableKey,
      ),
    })),
  );
} else {
  logger.warn(
    "Clerk is not fully configured (CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY); authenticated routes will return 401.",
  );
}

app.use("/api", router);

// Serve the built React app from the same origin so that `/api` calls work
// without a separate static host or CORS configuration.
const webDist = path.resolve(
  process.env.WEB_DIST_DIR ??
    path.resolve(__dirname, "../../ai-router/dist/public"),
);
const webIndex = path.join(webDist, "index.html");

if (process.env.SERVE_WEB !== "false" && fs.existsSync(webIndex)) {
  app.use(
    express.static(webDist, {
      index: false,
      maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    if (!req.accepts("html")) {
      next();
      return;
    }
    res.sendFile(webIndex);
  });
}

export default app;
