// SVELTEKIT-BACKEND-PRESERVED: moved out of svelte/ during the cljs migration; not wired.
//
// Extracted verbatim (logic unchanged) from `svelte/patch-worker.mjs` during
// the Svelte -> ClojureScript frontend migration (see ../cljs/). It was a
// post-`vite build` step (`package.json`'s `"build": "vite build && node
// patch-worker.mjs"`) that patched the SvelteKit adapter's generated worker
// (`.svelte-kit/cloudflare/_worker.js`) to append a stub `RelaySession`
// Durable Object export — a 410 "moved behind the agentgateway MCP router"
// response — so the SvelteKit-built worker file would export a class named
// `RelaySession` alongside whatever SvelteKit itself emitted.
//
// This is unrelated to the real `RelaySession` Durable Object implementation
// in `../src/worker.ts`, which is untouched by this migration.
//
// STATUS: not wired to anything. `workerPath` is a relative path into
// `.svelte-kit/cloudflare/`, which no longer exists — the cljs build does
// not produce a SvelteKit adapter worker to patch. Whether any of this
// stub-Durable-Object behaviour needs reviving against the new build output
// is a product decision this migration does not make. It is recorded here,
// unmodified, so the next reader does not have to reconstruct it from git
// history.

import { readFileSync, writeFileSync } from 'node:fs';

const workerPath = '.svelte-kit/cloudflare/_worker.js';
const marker = 'class RelaySession';
const compatExport = `

export class RelaySession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch() {
    return new Response(
      JSON.stringify({
        error: 'RelaySession has moved behind the agentgateway MCP router',
        router: this.env?.AGENTGATEWAY_MCP_ROUTER_URL ?? null
      }),
      {
        status: 410,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store'
        }
      }
    );
  }

  async alarm() {}
}
`;

const worker = readFileSync(workerPath, 'utf8');
if (!worker.includes(marker)) {
  writeFileSync(workerPath, `${worker.trimEnd()}${compatExport}`);
}
