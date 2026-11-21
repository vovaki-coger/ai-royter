import { Readable } from "node:stream";
import {
  and,
  count,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import { getAuth } from "@clerk/express";
import {
  db,
  routerKeysTable,
  routerProviderModelsTable,
  routerProvidersTable,
  routerRequestsTable,
  type RouterKey,
  type RouterProviderModel,
} from "@workspace/db";
import {
  CreateChatCompletionBody,
  CreateOpenAIResponseBody,
  CreateProviderBody,
  CreateProviderResponse,
  CreateRouterKeyBody,
  CreateRouterKeyResponse,
  GetRouterDashboardResponse,
  ListProvidersResponse,
  ListRouterKeysResponse,
  ListRouterRequestsQueryParams,
  ListRouterRequestsResponse,
  ListOpenAIModelsResponse,
  PreviewProviderModelsBody,
  PreviewProviderModelsResponse,
  RefreshProviderModelsParams,
  RefreshProviderModelsResponse,
  RevokeRouterKeyParams,
  TestRouterCompletionBody,
  TestRouterCompletionResponse,
} from "@workspace/api-zod";
import {
  Router,
  type IRouter,
  type Request,
  type RequestHandler,
  type Response as ExpressResponse,
} from "express";
import {
  discoverModels,
  providerKey,
  resolveProviderBaseUrl,
  splitRouteModel,
  toApiProvider,
  upstreamChatUrl,
  type ProviderKind,
} from "../lib/ai-router";
import {
  createRouterKey,
  encryptProviderKey,
  hashRouterKey,
  maskProviderKey,
  routerKeyMatches,
} from "../lib/router-security";

const router: IRouter = Router();
const authenticated: RequestHandler = (req, res, next) => {
  let userId: string | undefined;
  try {
    const auth = getAuth(req);
    userId = auth?.sessionClaims?.userId || auth?.userId;
  } catch {
    // Clerk is not configured (or its middleware is not mounted). Treat the
    // request as unauthenticated instead of failing with a 500.
  }
  if (!userId) {
    res.status(401).json({ error: "Sign in to manage your AI router." });
    return;
  }
  res.locals.userId = userId;
  next();
};

function currentUserId(res: Parameters<RequestHandler>[1]): string {
  const userId = res.locals.userId;
  if (typeof userId !== "string") {
    throw new Error("Authenticated user context is missing");
  }
  return userId;
}

async function requestRouterKey(
  req: Request,
  res: ExpressResponse,
): Promise<RouterKey | null> {
  const authorization = req.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(air_[A-Za-z0-9_-]+)$/i);
  if (!match) {
    res.status(401).json({ error: "A valid router key is required." });
    return null;
  }

  const secret = match[1];
  const [keyRecord] = await db
    .select()
    .from(routerKeysTable)
    .where(
      and(
        eq(routerKeysTable.secretHash, hashRouterKey(secret)),
        isNull(routerKeysTable.revokedAt),
      ),
    )
    .limit(1);
  if (!keyRecord || !routerKeyMatches(secret, keyRecord.secretHash)) {
    res.status(401).json({ error: "A valid router key is required." });
    return null;
  }
  return keyRecord;
}

function providerParams(value: unknown): { providerId: string } | null {
  const parsed = RefreshProviderModelsParams.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function findProvider(providerId: string, userId: string) {
  const [provider] = await db
    .select()
    .from(routerProvidersTable)
    .where(
      and(
        eq(routerProvidersTable.id, providerId),
        eq(routerProvidersTable.userId, userId),
      ),
    )
    .limit(1);
  return provider;
}

async function findProviderBySlug(providerSlug: string, userId: string) {
  const [provider] = await db
    .select()
    .from(routerProvidersTable)
    .where(
      and(
        eq(routerProvidersTable.providerSlug, providerSlug),
        eq(routerProvidersTable.userId, userId),
      ),
    )
    .limit(1);
  return provider;
}

async function loadProviderModels(providerIds: string[]) {
  if (!providerIds.length) return new Map<string, RouterProviderModel[]>();
  const rows = await db
    .select()
    .from(routerProviderModelsTable)
    .where(
      and(
        inArray(routerProviderModelsTable.providerId, providerIds),
        isNull(routerProviderModelsTable.unavailableUntil),
      ),
    );
  const byProvider = new Map<
    string,
    RouterProviderModel[]
  >();
  for (const model of rows) {
    const existing = byProvider.get(model.providerId) ?? [];
    existing.push(model);
    byProvider.set(model.providerId, existing);
  }
  return byProvider;
}

function providerConnection(
  provider: typeof routerProvidersTable.$inferSelect,
  models: (typeof routerProviderModelsTable.$inferSelect)[],
) {
  const apiProvider = toApiProvider(provider, models);
  return { provider: apiProvider, models: apiProvider.models };
}

async function verifiedBaseUrl(
  provider: typeof routerProvidersTable.$inferSelect,
): Promise<string> {
  return resolveProviderBaseUrl(
    provider.kind as ProviderKind,
    provider.kind === "custom" ? provider.baseUrl : null,
  );
}

const providerModelRefreshIntervalMs = 60_000;
const unsupportedModelSuppressionMs = 24 * 60 * 60 * 1000;
const providerModelRefreshes = new Map<string, Promise<void>>();

async function refreshProviderModelCatalog(
  provider: typeof routerProvidersTable.$inferSelect,
  userId: string,
): Promise<void> {
  const existingRefresh = providerModelRefreshes.get(provider.id);
  if (existingRefresh) {
    await existingRefresh;
    return;
  }

  const refresh = (async () => {
    const models = await discoverModels(
      await verifiedBaseUrl(provider),
      providerKey(provider),
    );
    await db.transaction(async (transaction) => {
      const now = new Date();
      const suppressedRows = await transaction
        .select({ modelId: routerProviderModelsTable.modelId })
        .from(routerProviderModelsTable)
        .where(
          and(
            eq(routerProviderModelsTable.providerId, provider.id),
            eq(routerProviderModelsTable.userId, userId),
            gt(routerProviderModelsTable.unavailableUntil, now),
          ),
        );
      const suppressedModelIds = new Set(
        suppressedRows.map((row) => row.modelId),
      );
      await transaction
        .delete(routerProviderModelsTable)
        .where(
          and(
            eq(routerProviderModelsTable.providerId, provider.id),
            eq(routerProviderModelsTable.userId, userId),
            or(
              isNull(routerProviderModelsTable.unavailableUntil),
              lte(routerProviderModelsTable.unavailableUntil, now),
            ),
          ),
        );
      const availableModels = models.filter(
        (model) => !suppressedModelIds.has(model.modelId),
      );
      if (availableModels.length) {
        await transaction.insert(routerProviderModelsTable).values(
          availableModels.map((model) => ({
            providerId: provider.id,
            userId,
            modelId: model.modelId,
            name: model.name,
            contextLength: model.contextLength,
            inputModalities: model.inputModalities,
            supportsVision: model.supportsVision,
          })),
        );
      }
      await transaction
        .update(routerProvidersTable)
        .set({ status: "connected", lastSyncedAt: new Date() })
        .where(
          and(
            eq(routerProvidersTable.id, provider.id),
            eq(routerProvidersTable.userId, userId),
          ),
        );
    });
  })();
  providerModelRefreshes.set(provider.id, refresh);
  try {
    await refresh;
  } finally {
    if (providerModelRefreshes.get(provider.id) === refresh) {
      providerModelRefreshes.delete(provider.id);
    }
  }
}

async function refreshStaleProviderModelCatalogs(
  providers: (typeof routerProvidersTable.$inferSelect)[],
  userId: string,
  onError: (providerId: string, message: string) => void,
): Promise<void> {
  const now = Date.now();
  const staleProviders = providers.filter(
    (provider) =>
      !provider.lastSyncedAt ||
      now - provider.lastSyncedAt.getTime() >= providerModelRefreshIntervalMs,
  );

  await Promise.all(
    staleProviders.map(async (provider) => {
      try {
        await refreshProviderModelCatalog(provider, userId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Model refresh failed.";
        await db
          .update(routerProvidersTable)
          .set({ status: "error", lastSyncedAt: new Date() })
          .where(
            and(
              eq(routerProvidersTable.id, provider.id),
              eq(routerProvidersTable.userId, userId),
            ),
          );
        onError(provider.id, message);
      }
    }),
  );
}

function refreshCatalogAfterNotFound(
  provider: typeof routerProvidersTable.$inferSelect,
  userId: string,
  onError: (message: string) => void,
): void {
  void refreshProviderModelCatalog(provider, userId).catch(async (error) => {
    const message =
      error instanceof Error ? error.message : "Model refresh failed.";
    await db
      .update(routerProvidersTable)
      .set({ status: "error", lastSyncedAt: new Date() })
      .where(
        and(
          eq(routerProvidersTable.id, provider.id),
          eq(routerProvidersTable.userId, userId),
        ),
      );
    onError(message);
  });
}

async function writeRequestLog(input: {
  userId: string;
  providerId: string;
  providerName: string;
  model: string;
  status: number;
  latencyMs: number;
}): Promise<void> {
  await db.insert(routerRequestsTable).values(input);
}

async function suppressUnavailableModel(
  providerId: string,
  userId: string,
  modelId: string,
): Promise<void> {
  await db
    .update(routerProviderModelsTable)
    .set({
      unavailableUntil: new Date(Date.now() + unsupportedModelSuppressionMs),
    })
    .where(
      and(
        eq(routerProviderModelsTable.providerId, providerId),
        eq(routerProviderModelsTable.userId, userId),
        eq(routerProviderModelsTable.modelId, modelId),
      ),
    );
}

async function resolveSelectedModel(
  userId: string,
  routeModel: string,
  onRefreshError: (providerId: string, message: string) => void = () => {},
) {
  const parsed = splitRouteModel(routeModel);
  if (!parsed) return null;

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      parsed.providerId,
    );
  let provider =
    (isUuid ? await findProvider(parsed.providerId, userId) : undefined) ??
    (await findProviderBySlug(parsed.providerId, userId));
  if (!provider) return null;

  await refreshStaleProviderModelCatalogs(
    [provider],
    userId,
    onRefreshError,
  );
  const currentProvider = await findProvider(provider.id, userId);
  if (!currentProvider || currentProvider.status !== "connected") return null;
  provider = currentProvider;

  const [model] = await db
    .select()
    .from(routerProviderModelsTable)
    .where(
      and(
        eq(routerProviderModelsTable.providerId, provider.id),
        eq(routerProviderModelsTable.modelId, parsed.modelId),
        eq(routerProviderModelsTable.userId, userId),
        isNull(routerProviderModelsTable.unavailableUntil),
      ),
    )
    .limit(1);
  if (!model) return null;
  return { provider, model };
}

const upstreamHeaderTimeoutMs = 30 * 60 * 1000;
const upstreamBodyTimeoutMs = 4 * 60 * 60 * 1000;
const upstreamStreamHeartbeatMs = 15 * 1000;

type UpstreamEndpoint = "chat/completions" | "responses";

async function sendUpstreamRequest(
  provider: typeof routerProvidersTable.$inferSelect,
  endpoint: UpstreamEndpoint,
  body: Record<string, unknown>,
  controller = new AbortController(),
): Promise<Response> {
  const baseUrl = await verifiedBaseUrl(provider);
  const url =
    endpoint === "chat/completions"
      ? upstreamChatUrl(baseUrl)
      : `${baseUrl}/responses`;
  const headerTimer = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          `The provider did not return response headers within ${upstreamHeaderTimeoutMs / 60_000} minutes.`,
          "TimeoutError",
        ),
      ),
    upstreamHeaderTimeoutMs,
  );
  headerTimer.unref?.();
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${providerKey(provider)}`,
        "Content-Type": "application/json",
        Accept:
          body.stream === true
            ? "text/event-stream, application/json"
            : "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(headerTimer);
  }
}

function attachClientDisconnectAbort(
  req: Request,
  res: ExpressResponse,
  controller: AbortController,
): () => void {
  const abortRequest = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("The client closed the request.", "AbortError"));
    }
  };
  const onResponseClose = () => {
    if (!res.writableEnded && !res.writableFinished) abortRequest();
    cleanup();
  };
  const cleanup = () => {
    req.off("aborted", abortRequest);
    res.off("close", onResponseClose);
    res.off("finish", cleanup);
  };

  req.once("aborted", abortRequest);
  res.once("close", onResponseClose);
  res.once("finish", cleanup);
  return cleanup;
}

function pipeProviderEventStream(
  upstream: Response,
  provider: typeof routerProvidersTable.$inferSelect,
  modelId: string,
  req: Request,
  res: ExpressResponse,
  controller: AbortController,
  onError: (error: unknown) => void,
): void {
  if (!upstream.body) return;
  const stream = Readable.fromWeb(
    upstream.body as import("node:stream/web").ReadableStream,
  );
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) {
      res.write(": router-keep-alive\n\n");
    }
  }, upstreamStreamHeartbeatMs);
  heartbeat.unref?.();
  const cleanup = () => clearInterval(heartbeat);

  stream.once("end", cleanup);
  stream.once("close", () => {
    cleanup();
    if (!stream.readableEnded && !res.destroyed && !res.writableEnded) {
      const error = new Error("The provider closed the stream before completion.");
      onError(error);
      if (!controller.signal.aborted) controller.abort(error);
      res.destroy();
    }
  });
  stream.once("error", (error) => {
    cleanup();
    req.log.warn(
      { providerId: provider.id, modelId, err: error },
      "Provider event stream ended before completion",
    );
    onError(error);
    if (!res.destroyed) res.destroy();
  });
  res.flushHeaders();
  stream.pipe(res);
}

async function relayUpstreamCompletion(input: {
  req: Request;
  res: ExpressResponse;
  provider: typeof routerProvidersTable.$inferSelect;
  keyRecord: RouterKey;
  routeModel: string;
  modelId: string;
  endpoint: UpstreamEndpoint;
  body: Record<string, unknown>;
}): Promise<void> {
  const { req, res, provider, keyRecord, routeModel, modelId, endpoint, body } =
    input;
  const controller = new AbortController();
  const detachAbortListeners = attachClientDisconnectAbort(
    req,
    res,
    controller,
  );
  const startedAt = Date.now();
  let status = 502;
  let requestLog: Promise<void> | null = null;
  const recordRequest = (requestStatus: number) => {
    if (requestLog) return requestLog;
    requestLog = Promise.all([
      writeRequestLog({
        userId: keyRecord.userId,
        providerId: provider.id,
        providerName: provider.name,
        model: routeModel,
        status: requestStatus,
        latencyMs: Date.now() - startedAt,
      }),
      db
        .update(routerKeysTable)
        .set({ lastUsedAt: new Date() })
        .where(eq(routerKeysTable.id, keyRecord.id)),
    ])
      .then(() => undefined)
      .catch((error) => {
        req.log.error(
          { providerId: provider.id, err: error },
          "Could not record routed request",
        );
      });
    return requestLog;
  };

  try {
    const upstream = await sendUpstreamRequest(
      provider,
      endpoint,
      body,
      controller,
    );
    status = upstream.status;
    if (upstream.status === 404) {
      if (endpoint === "chat/completions") {
        try {
          await suppressUnavailableModel(provider.id, keyRecord.userId, modelId);
        } catch (error) {
          req.log.warn(
            { providerId: provider.id, modelId, err: error },
            "Could not suppress a model rejected by its provider",
          );
        }
      }
      refreshCatalogAfterNotFound(provider, keyRecord.userId, (message) =>
        req.log.warn(
          { providerId: provider.id, error: message },
          "Provider returned 404; model catalog refresh failed",
        ),
      );
    }

    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("content-type", contentType);
    const cacheControl = upstream.headers.get("cache-control");
    if (cacheControl) res.setHeader("cache-control", cacheControl);
    for (const headerName of [
      "x-request-id",
      "retry-after",
      "openai-processing-ms",
      "x-ratelimit-limit-requests",
      "x-ratelimit-remaining-requests",
      "x-ratelimit-reset-requests",
    ]) {
      const value = upstream.headers.get(headerName);
      if (value) res.setHeader(headerName, value);
    }

    if (
      body.stream === true &&
      upstream.body &&
      contentType?.toLowerCase().includes("text/event-stream")
    ) {
      res.setHeader("cache-control", cacheControl ?? "no-cache, no-transform");
      res.setHeader("x-accel-buffering", "no");
      res.once("finish", () => {
        void recordRequest(status);
      });
      res.once("close", () => {
        if (!res.writableFinished) {
          const reason = controller.signal.reason;
          const closeStatus =
            reason instanceof DOMException && reason.name === "TimeoutError"
              ? 504
              : req.aborted ||
                  (reason instanceof DOMException &&
                    reason.name === "AbortError")
                ? 499
                : status;
          void recordRequest(closeStatus);
        }
      });
      pipeProviderEventStream(
        upstream,
        provider,
        modelId,
        req,
        res,
        controller,
        () => {
          const reason = controller.signal.reason;
          if (reason instanceof DOMException && reason.name === "TimeoutError") {
            status = 504;
          } else if (req.aborted || res.destroyed) {
            status = 499;
          } else {
            status = 502;
          }
        },
      );
      return;
    }

    const bodyTimer = setTimeout(
      () =>
        controller.abort(
          new DOMException(
            `The provider response body did not complete within ${upstreamBodyTimeoutMs / 60_000} minutes.`,
            "TimeoutError",
          ),
        ),
      upstreamBodyTimeoutMs,
    );
    bodyTimer.unref?.();
    let content: Buffer;
    try {
      content = Buffer.from(await upstream.arrayBuffer());
    } finally {
      clearTimeout(bodyTimer);
    }
    await recordRequest(status);
    res.end(content);
  } catch (error) {
    const disconnected = req.aborted || res.destroyed;
    const reason = controller.signal.reason;
    const timedOut = reason instanceof DOMException && reason.name === "TimeoutError";
    status = disconnected ? 499 : timedOut ? 504 : 502;
    await recordRequest(status);
    detachAbortListeners();
    if (disconnected) return;

    req.log.warn(
      { providerId: provider.id, modelId, err: error },
      "Routed provider request failed",
    );
    const message = timedOut
      ? "The provider took too long to respond. Retry the request or choose a faster model."
      : "The provider request could not be completed.";
    if (!res.headersSent) {
      res.status(status).json({ error: message });
      return;
    }
    res.end();
  }
}

async function sendUpstreamChat(
  provider: typeof routerProvidersTable.$inferSelect,
  body: Record<string, unknown>,
): Promise<Response> {
  return sendUpstreamRequest(provider, "chat/completions", body);
}

router.get("/providers", authenticated, async (req, res): Promise<void> => {
  const userId = currentUserId(res);
  let providers = await db
    .select()
    .from(routerProvidersTable)
    .where(eq(routerProvidersTable.userId, userId))
    .orderBy(desc(routerProvidersTable.createdAt));
  await refreshStaleProviderModelCatalogs(
    providers,
    userId,
    (providerId, message) =>
      req.log.warn(
        { providerId, error: message },
        "Provider model refresh failed; stale catalog hidden",
      ),
  );
  providers = await db
    .select()
    .from(routerProvidersTable)
    .where(eq(routerProvidersTable.userId, userId))
    .orderBy(desc(routerProvidersTable.createdAt));
  const modelsByProvider = await loadProviderModels(
    providers.map((provider) => provider.id),
  );
  const response = providers.map((provider) =>
    toApiProvider(
      provider,
      provider.status === "connected"
        ? modelsByProvider.get(provider.id) ?? []
        : [],
    ),
  );
  res.json(ListProvidersResponse.parse(response));
});

router.post(
  "/providers/preview-models",
  authenticated,
  async (req, res): Promise<void> => {
    const parsed = PreviewProviderModelsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    try {
      const baseUrl = await resolveProviderBaseUrl(
        parsed.data.kind as ProviderKind,
        parsed.data.baseUrl,
      );
      const models = await discoverModels(baseUrl, parsed.data.apiKey);
      if (!models.length) {
        res.status(400).json({
          error: "The provider returned no models for this API key.",
        });
        return;
      }
      res.json(PreviewProviderModelsResponse.parse({ models }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not fetch provider models.";
      res.status(400).json({ error: message });
    }
  },
);

router.post("/providers", authenticated, async (req, res): Promise<void> => {
  const userId = currentUserId(res);
  const parsed = CreateProviderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    kind,
    providerSlug,
    name,
    apiProtocol,
    apiKey,
    baseUrl: requestedBaseUrl,
  } = parsed.data;
  try {
    const [existing] = await db
      .select({ id: routerProvidersTable.id })
      .from(routerProvidersTable)
      .where(
        and(
          eq(routerProvidersTable.userId, userId),
          eq(routerProvidersTable.providerSlug, providerSlug),
        ),
      )
      .limit(1);
    if (existing) {
      res.status(409).json({
        error: "That provider ID is already in use. Choose a different one.",
      });
      return;
    }

    const resolvedBaseUrl = await resolveProviderBaseUrl(
      kind as ProviderKind,
      requestedBaseUrl,
    );
    const models = await discoverModels(resolvedBaseUrl, apiKey);
    if (!models.length) {
      res.status(400).json({
        error: "The provider returned no models for this API key.",
      });
      return;
    }

    const saved = await db.transaction(async (transaction) => {
      const [provider] = await transaction
        .insert(routerProvidersTable)
        .values({
          userId,
          kind,
          providerSlug,
          name: name.trim(),
          apiProtocol,
          baseUrl: resolvedBaseUrl,
          encryptedApiKey: encryptProviderKey(apiKey),
          keyHint: maskProviderKey(apiKey),
          status: "connected",
          lastSyncedAt: new Date(),
        })
        .returning();
      if (!provider) throw new Error("Provider could not be saved");

      const storedModels = await transaction
        .insert(routerProviderModelsTable)
        .values(
          models.map((model) => ({
            providerId: provider.id,
            userId,
            modelId: model.modelId,
            name: model.name,
            contextLength: model.contextLength,
            inputModalities: model.inputModalities,
            supportsVision: model.supportsVision,
          })),
        )
        .returning();
      return { provider, models: storedModels };
    });

    res
      .status(201)
      .json(CreateProviderResponse.parse(providerConnection(saved.provider, saved.models)));
  } catch (error) {
    const cause =
      typeof error === "object" && error !== null && "cause" in error
        ? error.cause
        : error;
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "23505"
    ) {
      res.status(409).json({
        error: "That provider ID is already in use. Choose a different one.",
      });
      return;
    }
    const message =
      error instanceof Error ? error.message : "Provider connection failed.";
    res.status(400).json({ error: message });
  }
});

router.post(
  "/providers/:providerId/refresh",
  authenticated,
  async (req, res): Promise<void> => {
    const userId = currentUserId(res);
    const params = providerParams(req.params);
    if (!params) {
      res.status(400).json({ error: "Invalid provider id." });
      return;
    }
    const provider = await findProvider(params.providerId, userId);
    if (!provider) {
      res.status(404).json({ error: "Provider not found." });
      return;
    }

    try {
      await refreshProviderModelCatalog(provider, userId);
      const freshModels = await db
        .select()
        .from(routerProviderModelsTable)
        .where(
          and(
            eq(routerProviderModelsTable.providerId, provider.id),
            isNull(routerProviderModelsTable.unavailableUntil),
          ),
        );
      const [updatedProvider] = await db
        .select()
        .from(routerProvidersTable)
        .where(eq(routerProvidersTable.id, provider.id))
        .limit(1);
      if (!updatedProvider) {
        res.status(404).json({ error: "Provider not found." });
        return;
      }
      res.json(
        RefreshProviderModelsResponse.parse(
          providerConnection(updatedProvider, freshModels),
        ),
      );
    } catch (error) {
      await db
        .update(routerProvidersTable)
        .set({ status: "error", lastSyncedAt: new Date() })
        .where(
          and(
            eq(routerProvidersTable.id, provider.id),
            eq(routerProvidersTable.userId, userId),
          ),
        );
      const message =
        error instanceof Error ? error.message : "Model refresh failed.";
      req.log.warn(
        { providerId: provider.id, error: message },
        "Provider model refresh failed",
      );
      res.status(502).json({ error: message });
    }
  },
);

router.delete(
  "/providers/:providerId",
  authenticated,
  async (req, res): Promise<void> => {
    const userId = currentUserId(res);
    const params = providerParams(req.params);
    if (!params) {
      res.status(400).json({ error: "Invalid provider id." });
      return;
    }
    const [deleted] = await db
      .delete(routerProvidersTable)
      .where(
        and(
          eq(routerProvidersTable.id, params.providerId),
          eq(routerProvidersTable.userId, userId),
        ),
      )
      .returning({ id: routerProvidersTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Provider not found." });
      return;
    }
    res.sendStatus(204);
  },
);

router.get("/router/keys", authenticated, async (_req, res): Promise<void> => {
  const userId = currentUserId(res);
  const keys = await db
    .select({
      id: routerKeysTable.id,
      name: routerKeysTable.name,
      prefix: routerKeysTable.prefix,
      createdAt: routerKeysTable.createdAt,
      lastUsedAt: routerKeysTable.lastUsedAt,
    })
    .from(routerKeysTable)
    .where(
      and(eq(routerKeysTable.userId, userId), isNull(routerKeysTable.revokedAt)),
    )
    .orderBy(desc(routerKeysTable.createdAt));
  res.json(ListRouterKeysResponse.parse(keys));
});

router.post("/router/keys", authenticated, async (req, res): Promise<void> => {
  const userId = currentUserId(res);
  const parsed = CreateRouterKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const secret = createRouterKey();
  const [created] = await db
    .insert(routerKeysTable)
    .values({
      userId,
      name: parsed.data.name.trim(),
      prefix: `${secret.slice(0, 12)}…`,
      secretHash: hashRouterKey(secret),
    })
    .returning({
      id: routerKeysTable.id,
      name: routerKeysTable.name,
      prefix: routerKeysTable.prefix,
      createdAt: routerKeysTable.createdAt,
      lastUsedAt: routerKeysTable.lastUsedAt,
    });
  if (!created) {
    res.status(500).json({ error: "Router key could not be created." });
    return;
  }
  res
    .status(201)
    .json(CreateRouterKeyResponse.parse({ ...created, key: secret }));
});

router.delete(
  "/router/keys/:keyId",
  authenticated,
  async (req, res): Promise<void> => {
    const params = RevokeRouterKeyParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const userId = currentUserId(res);
    const [deleted] = await db
      .delete(routerKeysTable)
      .where(
        and(
          eq(routerKeysTable.id, params.data.keyId),
          eq(routerKeysTable.userId, userId),
        ),
      )
      .returning({ id: routerKeysTable.id });
    if (!deleted) {
      res.status(404).json({ error: "Router key not found." });
      return;
    }
    res.sendStatus(204);
  },
);

router.get(
  "/router/requests",
  authenticated,
  async (req, res): Promise<void> => {
    const query = ListRouterRequestsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const userId = currentUserId(res);
    const requests = await db
      .select({
        id: routerRequestsTable.id,
        model: routerRequestsTable.model,
        providerName: routerRequestsTable.providerName,
        status: routerRequestsTable.status,
        latencyMs: routerRequestsTable.latencyMs,
        createdAt: routerRequestsTable.createdAt,
      })
      .from(routerRequestsTable)
      .where(eq(routerRequestsTable.userId, userId))
      .orderBy(desc(routerRequestsTable.createdAt))
      .limit(query.data.limit);
    res.json(ListRouterRequestsResponse.parse(requests));
  },
);

router.get(
  "/router/dashboard",
  authenticated,
  async (req, res): Promise<void> => {
    const userId = currentUserId(res);
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const providersToRefresh = await db
      .select()
      .from(routerProvidersTable)
      .where(eq(routerProvidersTable.userId, userId));
    await refreshStaleProviderModelCatalogs(
      providersToRefresh,
      userId,
      (providerId, message) =>
        req.log.warn(
          { providerId, error: message },
          "Provider model refresh failed; stale catalog hidden",
        ),
    );
    const [
      [providerCount],
      [modelCount],
      [routerKeyCount],
      [requestsToday],
      recentRequests,
    ] = await Promise.all([
      db
        .select({ count: count() })
        .from(routerProvidersTable)
        .where(eq(routerProvidersTable.userId, userId)),
      db
        .select({ count: count() })
        .from(routerProviderModelsTable)
        .innerJoin(
          routerProvidersTable,
          eq(
            routerProviderModelsTable.providerId,
            routerProvidersTable.id,
          ),
        )
        .where(
          and(
            eq(routerProviderModelsTable.userId, userId),
            eq(routerProvidersTable.userId, userId),
            eq(routerProvidersTable.status, "connected"),
            isNull(routerProviderModelsTable.unavailableUntil),
          ),
        ),
      db
        .select({ count: count() })
        .from(routerKeysTable)
        .where(
          and(
            eq(routerKeysTable.userId, userId),
            isNull(routerKeysTable.revokedAt),
          ),
        ),
      db
        .select({ count: count() })
        .from(routerRequestsTable)
        .where(
          and(
            eq(routerRequestsTable.userId, userId),
            gte(routerRequestsTable.createdAt, startOfDay),
          ),
        ),
      db
        .select({
          id: routerRequestsTable.id,
          model: routerRequestsTable.model,
          providerName: routerRequestsTable.providerName,
          status: routerRequestsTable.status,
          latencyMs: routerRequestsTable.latencyMs,
          createdAt: routerRequestsTable.createdAt,
        })
        .from(routerRequestsTable)
        .where(eq(routerRequestsTable.userId, userId))
        .orderBy(desc(routerRequestsTable.createdAt))
        .limit(8),
    ]);

    res.json(
      GetRouterDashboardResponse.parse({
        providerCount: Number(providerCount?.count ?? 0),
        modelCount: Number(modelCount?.count ?? 0),
        routerKeyCount: Number(routerKeyCount?.count ?? 0),
        requestsToday: Number(requestsToday?.count ?? 0),
        recentRequests,
      }),
    );
  },
);

router.post(
  "/router/test-completion",
  authenticated,
  async (req, res): Promise<void> => {
    const parsed = TestRouterCompletionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const userId = currentUserId(res);
    const selected = await resolveSelectedModel(
      userId,
      parsed.data.model,
      (providerId, message) =>
        req.log.warn(
          { providerId, error: message },
          "Provider model refresh failed before test request",
        ),
    );
    if (!selected) {
      res.status(404).json({ error: "Select a model from a connected provider." });
      return;
    }

    const startedAt = Date.now();
    let status = 502;
    try {
      const upstream = await sendUpstreamChat(selected.provider, {
        model: selected.model.modelId,
        messages: [{ role: "user", content: parsed.data.prompt }],
        max_tokens: 512,
      });
      status = upstream.status;
      if (upstream.status === 404) {
        try {
          await suppressUnavailableModel(
            selected.provider.id,
            userId,
            selected.model.modelId,
          );
        } catch (error) {
          req.log.warn(
            {
              providerId: selected.provider.id,
              modelId: selected.model.modelId,
              err: error,
            },
            "Could not suppress a model rejected by its provider",
          );
        }
        refreshCatalogAfterNotFound(selected.provider, userId, (message) =>
          req.log.warn(
            { providerId: selected.provider.id, error: message },
            "Provider returned 404; model catalog refresh failed",
          ),
        );
      }
      if (!upstream.ok) {
        await writeRequestLog({
          userId,
          providerId: selected.provider.id,
          providerName: selected.provider.name,
          model: parsed.data.model,
          status,
          latencyMs: Date.now() - startedAt,
        });
        res.status(502).json({
          error: `The provider returned HTTP ${upstream.status}. Check the provider status and try again.`,
        });
        return;
      }

      const payload = (await upstream.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      const response =
        typeof content === "string"
          ? content
          : content == null
            ? "The model returned an empty response."
            : JSON.stringify(content);
      await writeRequestLog({
        userId,
        providerId: selected.provider.id,
        providerName: selected.provider.name,
        model: parsed.data.model,
        status,
        latencyMs: Date.now() - startedAt,
      });
      res.json(
        TestRouterCompletionResponse.parse({
          model: parsed.data.model,
          providerName: selected.provider.name,
          response,
          latencyMs: Date.now() - startedAt,
        }),
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Provider request failed.";
      try {
        await writeRequestLog({
          userId,
          providerId: selected.provider.id,
          providerName: selected.provider.name,
          model: parsed.data.model,
          status,
          latencyMs: Date.now() - startedAt,
        });
      } catch {
        // Keep the provider error visible even if request history is unavailable.
      }
      res.status(502).json({ error: errorMessage });
    }
  },
);

router.get("/v1/models", async (req, res): Promise<void> => {
  const keyRecord = await requestRouterKey(req, res);
  if (!keyRecord) return;

  const providersToRefresh = await db
    .select()
    .from(routerProvidersTable)
    .where(eq(routerProvidersTable.userId, keyRecord.userId));
  await refreshStaleProviderModelCatalogs(
    providersToRefresh,
    keyRecord.userId,
    (providerId, message) =>
      req.log.warn(
        { providerId, error: message },
        "Provider model refresh failed; stale catalog hidden",
      ),
  );

  const [providers, models] = await Promise.all([
    db
      .select({
        id: routerProvidersTable.id,
        providerSlug: routerProvidersTable.providerSlug,
        createdAt: routerProvidersTable.createdAt,
        status: routerProvidersTable.status,
      })
      .from(routerProvidersTable)
      .where(eq(routerProvidersTable.userId, keyRecord.userId)),
    db
      .select({
        providerId: routerProviderModelsTable.providerId,
        modelId: routerProviderModelsTable.modelId,
        contextLength: routerProviderModelsTable.contextLength,
        inputModalities: routerProviderModelsTable.inputModalities,
        supportsVision: routerProviderModelsTable.supportsVision,
      })
      .from(routerProviderModelsTable)
      .where(
        and(
          eq(routerProviderModelsTable.userId, keyRecord.userId),
          isNull(routerProviderModelsTable.unavailableUntil),
        ),
      ),
  ]);
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const data = models
    .flatMap((model) => {
      const provider = providersById.get(model.providerId);
      if (!provider || provider.status !== "connected") return [];
      const owner = provider.providerSlug ?? provider.id;
      return [
        {
          id: `${owner}/${model.modelId}`,
          object: "model" as const,
          created: Math.floor(provider.createdAt.getTime() / 1000),
          owned_by: owner,
          ...(model.contextLength !== null
            ? { context_length: model.contextLength }
            : {}),
          ...(model.inputModalities
            ? {
                input_modalities: model.inputModalities,
                architecture: { input_modalities: model.inputModalities },
              }
            : {}),
          ...(model.supportsVision !== null
            ? { supports_vision: model.supportsVision }
            : {}),
        },
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  await db
    .update(routerKeysTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(routerKeysTable.id, keyRecord.id));

  res.setHeader("Cache-Control", "no-store");
  res.json(ListOpenAIModelsResponse.parse({ object: "list", data }));
});

router.post("/v1/chat/completions", async (req, res): Promise<void> => {
  const keyRecord = await requestRouterKey(req, res);
  if (!keyRecord) return;

  const parsed = CreateChatCompletionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const selected = await resolveSelectedModel(
    keyRecord.userId,
    parsed.data.model,
    (providerId, message) =>
      req.log.warn(
        { providerId, error: message },
        "Provider model refresh failed before chat request",
      ),
  );
  if (!selected) {
    res.status(404).json({ error: "Provider or model not found." });
    return;
  }

  const originalBody = req.body as Record<string, unknown>;
  const forwardedBody = {
    ...originalBody,
    ...parsed.data,
    model: selected.model.modelId,
    messages: originalBody.messages,
  };
  await relayUpstreamCompletion({
    req,
    res,
    provider: selected.provider,
    keyRecord,
    routeModel: parsed.data.model,
    modelId: selected.model.modelId,
    endpoint: "chat/completions",
    body: forwardedBody,
  });
});

router.post("/v1/responses", async (req, res): Promise<void> => {
  const keyRecord = await requestRouterKey(req, res);
  if (!keyRecord) return;

  const parsed = CreateOpenAIResponseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const selected = await resolveSelectedModel(
    keyRecord.userId,
    parsed.data.model,
    (providerId, message) =>
      req.log.warn(
        { providerId, error: message },
        "Provider model refresh failed before Responses API request",
      ),
  );
  if (!selected) {
    res.status(404).json({ error: "Provider or model not found." });
    return;
  }

  const originalBody = req.body as Record<string, unknown>;
  const forwardedBody = {
    ...originalBody,
    ...parsed.data,
    model: selected.model.modelId,
    input: originalBody.input,
  };
  await relayUpstreamCompletion({
    req,
    res,
    provider: selected.provider,
    keyRecord,
    routeModel: parsed.data.model,
    modelId: selected.model.modelId,
    endpoint: "responses",
    body: forwardedBody,
  });
});

export default router;
