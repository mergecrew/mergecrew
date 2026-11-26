/**
 * Minimal smart-HTTP git server for tests: node `http` in front of
 * `git http-backend` (CGI). Requires an `Authorization` header equal to
 * `expectedAuth`, and records every header it sees so tests can assert
 * credentials travelled per request (and nowhere else).
 */
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

export interface GitHttpServer {
  url: string;
  origin: string;
  close(): Promise<void>;
  seenAuth: string[];
}

export function gitExecPath(): string {
  return execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
}

export async function startGitHttpServer(projectRoot: string, expectedAuth: string): Promise<GitHttpServer> {
  const backend = path.join(gitExecPath(), 'git-http-backend');
  const seenAuth: string[] = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    seenAuth.push(auth);
    if (auth !== expectedAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      res.end('unauthorized');
      return;
    }
    const u = new URL(req.url ?? '/', 'http://localhost');
    const child = spawn(backend, [], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        REMOTE_USER: 'tester',
        REMOTE_ADDR: '127.0.0.1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: decodeURIComponent(u.pathname),
        QUERY_STRING: u.search.replace(/^\?/, ''),
        CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
        HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
        HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
      },
    });
    req.pipe(child.stdin);
    let buf = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      let idx = buf.indexOf('\r\n\r\n');
      let sepLen = 4;
      if (idx < 0) {
        idx = buf.indexOf('\n\n');
        sepLen = 2;
      }
      if (idx < 0) return;
      const head = buf.subarray(0, idx).toString('utf8');
      const rest = buf.subarray(idx + sepLen);
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.split(/\r?\n/)) {
        const c = line.indexOf(':');
        if (c < 0) continue;
        const k = line.slice(0, c).trim();
        const v = line.slice(c + 1).trim();
        if (k.toLowerCase() === 'status') status = Number(v.split(' ')[0]) || 200;
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      headersDone = true;
      if (rest.length) res.write(rest);
    });
    child.on('close', () => res.end());
    child.on('error', () => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: origin,
    origin,
    seenAuth,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
