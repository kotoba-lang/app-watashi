import {
  canReceive,
  canSend,
  decodeToken,
  messageKind,
} from "./worker.ts";

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signToken(payload: Record<string, unknown>, signingKey: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = bytesToBase64url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = bytesToBase64url(new TextEncoder().encode(JSON.stringify(payload)));
  const input = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return `${input}.${bytesToBase64url(new Uint8Array(signature))}`;
}

Deno.test("messageKind maps clipboard text and file-meta", () => {
  if (messageKind({ type: "clipboard", clipboard_kind: "text" }) !== "clipboard-text") {
    throw new Error("clipboard text should map to clipboard-text");
  }
  if (messageKind({ type: "clipboard", clipboard_kind: "file" }) !== "clipboard-file") {
    throw new Error("clipboard file should map to clipboard-file");
  }
  if (messageKind({ type: "file-meta" }) !== "file-meta") {
    throw new Error("file-meta should stay file-meta");
  }
});

Deno.test("policy gates clipboard and input directions", () => {
  const policy = {
    allowInputInbound: true,
    allowInputOutbound: false,
    allowClipboardText: true,
    allowClipboardFile: false,
    allowFileTransfer: false,
  };
  if (canSend(policy, "input")) throw new Error("input outbound should be denied");
  if (!canReceive(policy, "input")) throw new Error("input inbound should be allowed");
  if (!canSend(policy, "clipboard-text")) throw new Error("clipboard text should be allowed");
  if (canReceive(policy, "clipboard-file")) throw new Error("clipboard file should be denied");
});

Deno.test("decodeToken accepts valid relay token", async () => {
  const signingKey = "test-signing-key";
  const payload = {
    aud: "watashi-relay",
    exp: Math.floor(Date.now() / 1000) + 60,
    peer_id: "peer_a",
    role: "host",
    session_id: "sess_123",
    policy: {
      allowInputInbound: true,
      allowInputOutbound: true,
      allowClipboardText: true,
    },
  };
  const token = await signToken(payload, signingKey);
  const claims = await decodeToken(token, signingKey);
  if (claims.peer_id !== "peer_a") throw new Error("peer_id mismatch");
  if (claims.session_id !== "sess_123") throw new Error("session_id mismatch");
  if (!claims.policy?.allowClipboardText) throw new Error("policy missing");
});
