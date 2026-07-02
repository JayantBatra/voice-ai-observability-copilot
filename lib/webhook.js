// webhook.js — verify HighLevel webhook authenticity.
//
// HighLevel signs the raw request body. It sends Ed25519 signatures in
// `X-GHL-Signature` (current) and, during the transition, RSA-SHA256 in
// `X-WH-Signature` (legacy, deprecated 2026-07-01). We prefer Ed25519 and fall
// back to RSA. Public keys are published by HighLevel (below); override via
// GHL_ED25519_PUBLIC_KEY / GHL_RSA_PUBLIC_KEY env vars if they ever rotate.
//
// Source: https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide

import crypto from "node:crypto";

const ED25519_PUBLIC_KEY = process.env.GHL_ED25519_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

const RSA_PUBLIC_KEY = process.env.GHL_RSA_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

function verifyEd25519(rawBody, signature) {
  try {
    return crypto.verify(null, Buffer.from(rawBody, "utf8"), ED25519_PUBLIC_KEY, Buffer.from(signature, "base64"));
  } catch { return false; }
}

function verifyRsa(rawBody, signature) {
  try {
    const v = crypto.createVerify("SHA256");
    v.update(rawBody);
    return v.verify(RSA_PUBLIC_KEY, signature, "base64");
  } catch { return false; }
}

/**
 * @param {string} rawBody  exact bytes of the request body (not re-serialized)
 * @param {object} headers  lower-cased request headers
 * @returns {{ok: boolean, reason: string}}
 */
export function verifyWebhook(rawBody, headers) {
  // Escape hatch for local testing without a live GHL signer.
  if (process.env.VERIFY_WEBHOOKS === "false") return { ok: true, reason: "verification disabled" };

  const ghlSig = headers["x-ghl-signature"];
  const legacySig = headers["x-wh-signature"];
  if (ghlSig) return { ok: verifyEd25519(rawBody, ghlSig), reason: "ed25519" };
  if (legacySig) return { ok: verifyRsa(rawBody, legacySig), reason: "rsa-legacy" };
  return { ok: false, reason: "no signature header" };
}
