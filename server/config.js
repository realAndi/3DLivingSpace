// Settings from the environment. Locally `npm start` serves everything at
// http://localhost:8790/; on the droplet the container listens on a socket and
// lives under /3DLivingSpace.
import { fileURLToPath } from 'node:url';

export function loadConfig(env = process.env) {
  const base = (env.BASE_PATH ?? '').replace(/^\/+|\/+$/g, '');
  return {
    listen: env.LISTEN ?? env.PORT ?? '8790',
    basePath: base ? `/${base}` : '',
    // Absolute links (MCP replies, link previews). Without it, taken from the request.
    publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
    dataDir: env.DATA_DIR ?? fileURLToPath(new URL('../data', import.meta.url)),
    root: fileURLToPath(new URL('..', import.meta.url)),
    bodyBytes: 600_000,
    // MCP requests: build_unit can carry a whole unit.
    mcpBytes: 400_000,
  };
}
