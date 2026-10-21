import http from 'node:http';
import https from 'node:https';

/**
 * Decides where the Merchant Admin should forward /api/* requests.
 *
 * - BASE_PAYMENT_API_URL unset, or pointing at localhost  -> the original behaviour
 *   (127.0.0.1 : PAYMENT_API_PORT, plain http).
 * - BASE_PAYMENT_API_URL = https://your-gateway.example.com -> the admin is hosted
 *   separately from the Payment API and forwards over the network (http or https).
 */
export function resolveApiTarget(env = process.env) {
  const local = {
    remote: false,
    transport: http,
    hostname: '127.0.0.1',
    port: Number(env.PAYMENT_API_PORT || 6100),
    hostHeader: `localhost:${Number(env.PAYMENT_API_PORT || 6100)}`,
    basePath: ''
  };

  const raw = String(env.BASE_PAYMENT_API_URL || '').trim();
  if (!raw) return local;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return local;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return local;

  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (loopback) return local;

  const isHttps = url.protocol === 'https:';

  return {
    remote: true,
    transport: isHttps ? https : http,
    hostname: url.hostname,
    port: Number(url.port) || (isHttps ? 443 : 80),
    hostHeader: url.host,
    basePath: url.pathname.replace(/\/+$/, '')
  };
}

/**
 * Forwards one request to the Payment API described by `target`.
 * `extraHeaders` are merged over the incoming headers.
 */
export function proxyToPaymentApi(req, res, target, extraHeaders = {}) {
  const isStream = /\/stream(\?|$)/.test(req.url || '');

  const headers = {
    ...req.headers,
    ...extraHeaders,
    host: target.hostHeader
  };

  const proxyReq = target.transport.request({
    hostname: target.hostname,
    port: target.port,
    path: `${target.basePath}${req.url}`,
    method: req.method,
    headers
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  // A free-tier host can take a while to wake up, so allow a generous
  // timeout - but never for the live event stream.
  if (!isStream) {
    proxyReq.setTimeout(60000, () => {
      proxyReq.destroy(new Error('Payment API timed out'));
    });
  }

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({
      error: 'Gateway API unavailable',
      details: err.message,
      target: `${target.hostname}:${target.port}`
    }));
  });

  req.pipe(proxyReq);
}
