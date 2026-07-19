export {};

declare const Deno: {
  args: string[];
};

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signToken(payload: Record<string, unknown>, signingKey: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const input =
    `${base64url(new TextEncoder().encode(JSON.stringify(header)))}.` +
    `${base64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(sig))}`;
}

async function openSocket(
  baseUrl: string,
  sessionId: string,
  peerId: string,
  role: string,
  token: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${baseUrl}/relay?session_id=${encodeURIComponent(sessionId)}&peer_id=${encodeURIComponent(peerId)}&role=${role}&token=${encodeURIComponent(token)}`,
    );
    const timeout = setTimeout(() => reject(new Error(`timeout opening ${peerId}`)), 5000);
    ws.onmessage = (event) => {
      const data = JSON.parse(String(event.data));
      if (data.type === "control" && data.event === "connected") {
        clearTimeout(timeout);
        resolve(ws);
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`socket error ${peerId}`));
    };
  });
}

const baseUrl = Deno.args[0] ?? "http://localhost:8899";
const signingKey = Deno.args[1] ?? "test-signing-key";
const sessionId = `sess_${Date.now()}`;
const policy = {
  allowInputInbound: true,
  allowInputOutbound: true,
  allowClipboardText: true,
  allowClipboardFile: false,
  allowFileTransfer: false,
  managedDevice: false,
};

const hostToken = await signToken({
  aud: "watashi-relay",
  exp: Math.floor(Date.now() / 1000) + 600,
  peer_id: "peer_host",
  role: "host",
  session_id: sessionId,
  policy,
}, signingKey);
const clientToken = await signToken({
  aud: "watashi-relay",
  exp: Math.floor(Date.now() / 1000) + 600,
  peer_id: "peer_client",
  role: "client",
  session_id: sessionId,
  policy,
}, signingKey);

const wsBase = baseUrl.replace(/^http/, "ws");
const hostWs = await openSocket(wsBase, sessionId, "peer_host", "host", hostToken);
const clientWs = await openSocket(wsBase, sessionId, "peer_client", "client", clientToken);

const clipboardMessagePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("timeout waiting for clipboard frame")), 5000);
  clientWs.onmessage = (event) => {
    const data = JSON.parse(String(event.data));
    if (data.type === "clipboard") {
      clearTimeout(timeout);
      resolve(data);
    }
  };
});

hostWs.send(JSON.stringify({
  type: "clipboard",
  clipboard_kind: "text",
  text: "hello-from-smoke-test",
}));

const forwarded = await clipboardMessagePromise;
await new Promise((resolve) => setTimeout(resolve, 300));
const audit = await fetch(
  `${baseUrl}/auditz?session_id=${encodeURIComponent(sessionId)}&limit=20`,
).then((response) => response.json());

hostWs.close();
clientWs.close();

const auditEvents = (audit.events ?? []).map((event: Record<string, unknown>) => ({
  event: event.event,
  peer_id: event.peer_id,
  source_peer_id: event.source_peer_id,
  message_type: event.message_type,
}));

const hasForward = auditEvents.some((event: Record<string, unknown>) =>
  event.event === "message_forwarded" && event.message_type === "clipboard-text"
);
if (!hasForward) {
  console.error(JSON.stringify({ sessionId, forwarded, auditEvents }, null, 2));
  throw new Error("missing clipboard-text audit event");
}

console.log(JSON.stringify({ sessionId, forwarded, auditEvents }, null, 2));
