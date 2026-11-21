import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

function encryptionKey(): Buffer {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET is required to protect provider credentials");
  }

  return createHash("sha256")
    .update(`ai-router-provider-keys:v1:${sessionSecret}`)
    .digest();
}

export function encryptProviderKey(value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    nonce.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptProviderKey(value: string): string {
  const [version, nonceValue, tagValue, ciphertextValue] = value.split(".");
  if (
    version !== "v1" ||
    !nonceValue ||
    !tagValue ||
    !ciphertextValue
  ) {
    throw new Error("Stored provider credential has an unsupported format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(nonceValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hashRouterKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function routerKeyMatches(value: string, storedHash: string): boolean {
  const actual = Buffer.from(hashRouterKey(value), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createRouterKey(): string {
  return `air_${randomBytes(32).toString("base64url")}`;
}

export function maskProviderKey(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 6)}••••${value.slice(-4)}`;
}
