// Small HTTP helpers: JSON replies, bodies with a size cap, client addresses
// and per-address rate limits.

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

export function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

export function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new AppError(413, 'That is too much at once.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, max) {
  const body = await readBody(req, max);
  try {
    return body.length ? JSON.parse(body.toString('utf8')) : {};
  } catch {
    throw new AppError(400, 'The request body is not valid JSON.');
  }
}

// On the droplet nginx is the only client (over the socket) and sets X-Real-IP.
export function clientIp(req) {
  const real = req.headers['x-real-ip'];
  const fromProxy = !req.socket.remoteAddress || req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1';
  return (fromProxy && typeof real === 'string' && real) || req.socket.remoteAddress || 'unknown';
}

// Fixed-window counters per address.
export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  // Seconds to wait, or 0 if this request may go ahead.
  take(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) {
      e = { start: now, n: 0 };
      this.hits.set(key, e);
    }
    e.n++;
    if (this.hits.size > 20000) for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
    return e.n > this.limit ? Math.ceil((e.start + this.windowMs - now) / 1000) : 0;
  }
}

export function limit(limiter, key, what = 'requests') {
  const wait = limiter.take(key);
  if (wait) {
    const err = new AppError(429, `Too many ${what} from this address. Try again in ${wait} seconds.`);
    err.retryAfter = wait;
    throw err;
  }
}
