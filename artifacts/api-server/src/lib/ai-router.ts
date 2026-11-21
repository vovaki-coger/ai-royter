import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type {
  RouterProvider,
  RouterProviderModel,
} from "@workspace/db";
import { decryptProviderKey } from "./router-security";

export type ProviderKind =
  | "nvidia"
  | "openrouter"
  | "deepseek"
  | "openai"
  | "custom";

const fixedProviderUrls: Record<Exclude<ProviderKind, "custom">, string> = {
  nvidia: "https://integrate.api.nvidia.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com/v1",
};

const privateIpv4 = (address: string): boolean => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

function privateIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return privateIpv4(address);
  if (version !== 6) return true;

  const normalized = address.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  ) {
    return true;
  }

  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mappedIpv4 ? privateIpv4(mappedIpv4[1]) : false;
}

export async function resolveProviderBaseUrl(
  kind: ProviderKind,
  customBaseUrl?: string | null,
): Promise<string> {
  if (kind !== "custom") return fixedProviderUrls[kind];

  if (!customBaseUrl) {
    throw new Error("Enter an OpenAI-compatible HTTPS base URL");
  }

  let url: URL;
  try {
    url = new URL(customBaseUrl.trim());
  } catch {
    throw new Error("Enter a valid HTTPS base URL");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isIP(url.hostname) ||
    /(^|\.)((localhost)|(local)|(internal))$/i.test(url.hostname)
  ) {
    throw new Error("Custom providers must use a public HTTPS host");
  }

  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => privateIp(address))) {
    throw new Error("Custom provider host must resolve to a public address");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export type DiscoveredModel = {
  modelId: string;
  name: string;
  contextLength: number | null;
  inputModalities: string[] | null;
  supportsVision: boolean | null;
};

const knownInputModalities = new Set(["text", "image", "audio", "video", "file"]);

function normalizeInputModalities(value: unknown): string[] | null {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,+]/)
      : [];
  const normalized = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .map((item) => (item === "images" ? "image" : item))
    .filter((item) => knownInputModalities.has(item));
  return normalized.length ? [...new Set(normalized)] : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseModalityDescriptor(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  return normalizeInputModalities(value.split("->", 1)[0]);
}

const unavailableModelStates = new Set([
  "archived",
  "blocked",
  "decommissioned",
  "deprecated",
  "disabled",
  "deleted",
  "inactive",
  "not-available",
  "no-access",
  "no-longer-supported",
  "not-supported",
  "offline",
  "paused",
  "retired",
  "suspended",
  "unavailable",
  "unsupported",
]);

export async function discoverModels(
  baseUrl: string,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "The provider rejected this API key. Check the key and try again."
        : `The provider could not list models (HTTP ${response.status}).`,
    );
  }

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") {
    throw new Error("The provider returned an invalid model list");
  }

  const record = payload as { data?: unknown; models?: unknown };
  const rawModels = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (!rawModels) {
    throw new Error("The provider response did not include a model list");
  }

  const models = rawModels.flatMap((raw): DiscoveredModel[] => {
    if (!raw || typeof raw !== "object") return [];
    const model = raw as Record<string, unknown>;
    const states = [
      model.status,
      model.state,
      model.lifecycle_state,
      model.lifecycleStatus,
      model.availability,
      model.availability_status,
      model.availabilityStatus,
    ].flatMap((value) =>
      typeof value === "string"
        ? [value.toLowerCase().replaceAll("_", "-").replaceAll(" ", "-")]
        : [],
    );
    if (
      model.active === false ||
      model.is_active === false ||
      model.available === false ||
      model.is_available === false ||
      model.enabled === false ||
      model.supported === false ||
      model.is_supported === false ||
      model.disabled === true ||
      model.blocked === true ||
      model.hidden === true ||
      model.deleted === true ||
      model.deprecated === true ||
      model.is_deprecated === true ||
      states.some((state) => unavailableModelStates.has(state))
    ) {
      return [];
    }
    const modelId =
      typeof model.id === "string"
        ? model.id
        : typeof model.name === "string"
          ? model.name
          : null;
    if (!modelId || modelId.length > 500) return [];

    const contextCandidate =
      model.context_length ??
      model.contextLength ??
      model.context_window ??
      model.contextWindow ??
      model.max_context_length ??
      model.maxContextLength ??
      model.max_model_len;
    const contextLength =
      typeof contextCandidate === "number" &&
      Number.isFinite(contextCandidate) &&
      contextCandidate > 0
        ? Math.round(contextCandidate)
        : null;
    const architecture = recordValue(model.architecture);
    const capabilities =
      recordValue(model.capabilities) ?? recordValue(model.features);
    const inputModalities =
      [
        model.input_modalities,
        model.inputModalities,
        model.supported_input_modalities,
        model.supportedInputModalities,
        architecture?.input_modalities,
        architecture?.inputModalities,
      ]
        .map(normalizeInputModalities)
        .find((modalities) => modalities !== null) ??
      parseModalityDescriptor(model.modality) ??
      parseModalityDescriptor(architecture?.modality);
    const visionFlag = [
      model.supports_vision,
      model.supportsVision,
      model.vision,
      model.image_input,
      model.imageInput,
      capabilities?.vision,
      capabilities?.image,
    ].find((value): value is boolean => typeof value === "boolean");
    const supportsVision =
      inputModalities !== null
        ? inputModalities.includes("image")
        : visionFlag ?? null;

    return [
      {
        modelId,
        name:
          typeof model.name === "string" && model.name.length <= 500
            ? model.name
            : modelId,
        contextLength,
        inputModalities:
          inputModalities ?? (supportsVision ? ["text", "image"] : null),
        supportsVision,
      },
    ];
  });

  const unique = new Map(models.map((model) => [model.modelId, model]));
  return [...unique.values()].slice(0, 5000);
}

export function toApiModel(
  model: RouterProviderModel,
): {
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  contextLength: number | null;
} {
  return {
    id: model.id,
    providerId: model.providerId,
    modelId: model.modelId,
    name: model.name,
    contextLength: model.contextLength,
  };
}

export function toApiProvider(
  provider: RouterProvider,
  models: RouterProviderModel[],
): {
  id: string;
  kind: ProviderKind;
  providerSlug: string;
  name: string;
  apiProtocol: "openai_chat_completions";
  baseUrl: string;
  keyHint: string;
  modelCount: number;
  status: "connected" | "error";
  createdAt: Date;
  lastSyncedAt: Date | null;
  models: ReturnType<typeof toApiModel>[];
} {
  return {
    id: provider.id,
    kind: provider.kind as ProviderKind,
    providerSlug: provider.providerSlug ?? provider.id,
    name: provider.name,
    apiProtocol: "openai_chat_completions",
    baseUrl: provider.baseUrl,
    keyHint: provider.keyHint,
    modelCount: models.length,
    status: provider.status === "error" ? "error" : "connected",
    createdAt: provider.createdAt,
    lastSyncedAt: provider.lastSyncedAt,
    models: models.map(toApiModel),
  };
}

export function splitRouteModel(
  routeModel: string,
): { providerId: string; modelId: string } | null {
  const slash = routeModel.indexOf("/");
  if (slash < 1 || slash === routeModel.length - 1) return null;
  const providerId = routeModel.slice(0, slash);
  const modelId = routeModel.slice(slash + 1);
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(providerId);
  const isSlug = /^[a-z][a-z0-9_-]{0,62}$/.test(providerId);
  if (!isUuid && !isSlug) {
    return null;
  }
  return { providerId, modelId };
}

export function providerKey(provider: RouterProvider): string {
  return decryptProviderKey(provider.encryptedApiKey);
}

export function upstreamChatUrl(baseUrl: string): string {
  return `${baseUrl}/chat/completions`;
}
