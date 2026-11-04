// ADMIN_PASSWORD set on the host must win over the hash the setup page stored, and changing it must
// sign every client out: the README's forgotten-password and kill-switch instructions depend on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scrypt = (password: string) => {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, 64).toString("base64")}`;
};

for (const k of ["EB_APP_ID", "EB_PRIVATE_KEY", "EB_PRIVATE_KEY_PATH", "ADMIN_PASSWORD", "ADMIN_PASSWORD_HASH", "NOTIFY_WEBHOOK_URL"]) delete process.env[k];
const dataDir = mkdtempSync(join(tmpdir(), "bank-pw-"));
const storedHash = scrypt("password-from-setup-page");
writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ admin_password_hash: storedHash }));
// The state a setup-page install is in: tokens issued under the stored hash.
const fingerprint = createHash("sha256").update(storedHash).digest("hex");
writeFileSync(
  join(dataDir, "bank.json"),
  JSON.stringify({ oauth: { clients: {}, codes: {}, tokens: { abc: { kind: "access", client_id: "c", scopes: [], expires: 4102444800 } }, password_fingerprint: fingerprint } }),
);
process.env.DATA_DIR = dataDir;
process.env.BASE_URL = "http://localhost:8080";

const { verifyPassword } = await import("../src/auth.ts");

test("without ADMIN_PASSWORD the stored hash is used", () => {
  assert.equal(verifyPassword("password-from-setup-page"), true);
});

test("ADMIN_PASSWORD replaces the stored hash", () => {
  process.env.ADMIN_PASSWORD = "password-from-environment";
  try {
    assert.equal(verifyPassword("password-from-environment"), true);
    assert.equal(verifyPassword("password-from-setup-page"), false);
  } finally {
    delete process.env.ADMIN_PASSWORD;
  }
});

test("ADMIN_PASSWORD_HASH still wins over ADMIN_PASSWORD", () => {
  process.env.ADMIN_PASSWORD = "password-from-environment";
  process.env.ADMIN_PASSWORD_HASH = scrypt("hash-from-environment");
  try {
    assert.equal(verifyPassword("hash-from-environment"), true);
    assert.equal(verifyPassword("password-from-environment"), false);
  } finally {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD_HASH;
  }
});

test("starting with ADMIN_PASSWORD set revokes the tokens issued under the stored hash", async () => {
  process.env.ADMIN_PASSWORD = "password-from-environment";
  try {
    const { store } = await import("../src/store.ts");
    assert.equal(Object.keys(store().data.oauth.tokens).length, 1);
    const { createApp } = await import("../src/app.ts");
    createApp({ remote: true });
    assert.equal(Object.keys(store().data.oauth.tokens).length, 0);
  } finally {
    delete process.env.ADMIN_PASSWORD;
  }
});
