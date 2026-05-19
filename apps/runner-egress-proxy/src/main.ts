import net from 'node:net';
import pino from 'pino';
import { isHostAllowed, parseAllowlistEnv, parseConnectTarget } from './allowlist.js';

/**
 * Mergecrew runner egress proxy (#575).
 *
 * A small forward HTTP/HTTPS proxy the sandbox uses via the standard
 * HTTPS_PROXY / HTTP_PROXY env. Two responsibilities:
 *
 *   1. Enforce the per-project hostname allowlist on every outbound
 *      attempt — closes the residual gap when nftables (#573) doesn't
 *      have the destination IP and the DNS resolver (#574) doesn't
 *      catch direct-IP connects.
 *   2. Audit log every decision so operators see *what* the build
 *      tried to reach, not just whether it was blocked (the latter
 *      is what nftables counters give us).
 *
 * Deliberately NOT a TLS MITM. The proxy reads the CONNECT line for
 * HTTPS or the request line + Host header for HTTP, makes the
 * allow/deny decision against the hostname, and then either tunnels
 * raw TCP or closes. No TLS interception, no cert injection.
 */

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'runner-egress-proxy' },
  ...(process.env.NODE_ENV !== 'production'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

const PORT = Number(process.env.RUNNER_EGRESS_PROXY_PORT ?? 3128);
const ALLOWLIST = parseAllowlistEnv(process.env.RUNNER_EGRESS_PROXY_ALLOWLIST);
const HEADER_READ_TIMEOUT_MS = Number(process.env.RUNNER_EGRESS_PROXY_HEADER_TIMEOUT_MS ?? 5000);
const HEADER_MAX_BYTES = 16 * 1024;

const server = net.createServer((client) => {
  const src = client.remoteAddress;
  let header = '';

  const timer = setTimeout(() => {
    logger.warn({ src }, 'header read timeout; closing');
    client.destroy();
  }, HEADER_READ_TIMEOUT_MS);

  client.once('error', (err) => {
    clearTimeout(timer);
    logger.warn({ src, err: err.message }, 'client socket error');
  });

  const onData = (chunk: Buffer): void => {
    header += chunk.toString('binary');
    if (header.length > HEADER_MAX_BYTES) {
      clearTimeout(timer);
      client.removeListener('data', onData);
      logger.warn({ src }, 'header oversize; closing');
      client.destroy();
      return;
    }
    const headerEnd = header.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    clearTimeout(timer);
    client.removeListener('data', onData);

    const headBlock = header.slice(0, headerEnd);
    const trailing = header.slice(headerEnd + 4);
    const firstLine = headBlock.split('\r\n')[0] ?? '';

    if (firstLine.startsWith('CONNECT ')) {
      handleConnect(client, firstLine, src);
      return;
    }
    // Plain-HTTP fallback: parse Host header.
    const host = parseHttpHostHeader(headBlock);
    if (!host) {
      writeAndClose(client, 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      logger.warn({ src }, 'unrecognized request line; closing');
      return;
    }
    handlePlainHttp(client, host, headBlock + '\r\n\r\n' + trailing, src);
  };

  client.on('data', onData);
});

function handleConnect(client: net.Socket, firstLine: string, src: string | undefined): void {
  const target = parseConnectTarget(firstLine);
  if (!target) {
    writeAndClose(client, 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  if (!isHostAllowed(target.host, ALLOWLIST)) {
    logger.info(
      { event: 'egress.blocked', method: 'CONNECT', host: target.host, port: target.port, src },
      'blocked',
    );
    writeAndClose(client, 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = net.createConnection({ host: target.host, port: target.port });
  let bytesUp = 0;
  let bytesDown = 0;
  upstream.once('connect', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('data', (b) => { bytesUp += b.length; });
    upstream.on('data', (b) => { bytesDown += b.length; });
    logger.info(
      { event: 'egress.allowed', method: 'CONNECT', host: target.host, port: target.port, src },
      'tunneled',
    );
  });
  upstream.once('error', (err) => {
    logger.warn({ host: target.host, err: err.message }, 'upstream connect failed');
    writeAndClose(client, 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  client.once('close', () => {
    upstream.destroy();
    logger.info(
      { event: 'egress.closed', host: target.host, bytesUp, bytesDown, src },
      'connection closed',
    );
  });
  upstream.once('close', () => {
    client.destroy();
  });
}

function handlePlainHttp(
  client: net.Socket,
  host: string,
  fullRequest: string,
  src: string | undefined,
): void {
  if (!isHostAllowed(host, ALLOWLIST)) {
    logger.info({ event: 'egress.blocked', method: 'HTTP', host, src }, 'blocked');
    writeAndClose(client, 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = net.createConnection({ host, port: 80 });
  upstream.once('connect', () => {
    upstream.write(Buffer.from(fullRequest, 'binary'));
    client.pipe(upstream);
    upstream.pipe(client);
    logger.info({ event: 'egress.allowed', method: 'HTTP', host, src }, 'tunneled');
  });
  upstream.once('error', (err) => {
    logger.warn({ host, err: err.message }, 'upstream HTTP connect failed');
    writeAndClose(client, 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  client.once('close', () => upstream.destroy());
  upstream.once('close', () => client.destroy());
}

function parseHttpHostHeader(headBlock: string): string | null {
  const m = headBlock.match(/\r\nHost:\s*([^\r\n:]+)(?::\d+)?\b/i);
  return m?.[1] ?? null;
}

function writeAndClose(s: net.Socket, payload: string): void {
  try {
    s.write(payload);
  } catch {
    /* ignore */
  }
  s.end();
}

server.on('listening', () => {
  const addr = server.address();
  logger.info(
    { port: typeof addr === 'object' && addr ? addr.port : PORT, allowlistSize: ALLOWLIST.length },
    'runner-egress-proxy: listening',
  );
});

server.on('error', (err) => {
  logger.error({ err: err.message }, 'runner-egress-proxy: server error');
  process.exit(1);
});

server.listen(PORT);

function shutdown(): void {
  logger.info('runner-egress-proxy: shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
