// Relay in front of Next.js: edge proxy → this relay → Next.js.
//
// Drops X-Forwarded-Proto. With it set to https, Next.js treats its own
// locale rewrite (/login → /ar/login) as an external https proxy to
// localhost and fails. TLS ends at the edge; after it, plain HTTP. Appends the caller to X-Forwarded-For like any proxy hop.
import http from 'node:http';

const listenPort = Number(process.argv[2] ?? 3099);
const targetPort = Number(process.argv[3] ?? 3100);
const listenHost = process.argv[4] ?? '127.0.0.1';

http
  .createServer((req, res) => {
    const headers = { ...req.headers };
    delete headers['x-forwarded-proto'];
    const peer = req.socket.remoteAddress ?? '127.0.0.1';
    headers['x-forwarded-for'] = headers['x-forwarded-for']
      ? `${headers['x-forwarded-for']}, ${peer}`
      : peer;
    const upstream = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.rawHeaders);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('Upstream unavailable');
    });
    req.pipe(upstream);
  })
  .listen(listenPort, listenHost, () => {
    console.log(`relay :${listenPort} → :${targetPort}`);
  });
