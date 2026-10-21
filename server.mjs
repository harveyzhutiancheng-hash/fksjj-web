import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json' };
http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) {
      const upstream = http.request({hostname:'127.0.0.1',port:Number(process.env.API_PORT || 4180),path:req.url,method:req.method,headers:{...req.headers,'x-real-ip':req.socket.remoteAddress}}, incoming=>{res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);});
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({code:'unavailable',message:'账号服务暂时不可用，游客进度仍可保存在本机。'}));});
      req.pipe(upstream);return;
    }
    if (/^\/(?:api|deploy|docs|test-results)(?:\/|$)/.test(pathname) || /\.(?:sqlite3?|db|py|toml|env)(?:$|\.)/.test(pathname)) {res.writeHead(404).end();return;}
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const info = await stat(path);
    if (!info.isFile() || pathname.split('/').some(p => p.startsWith('.'))) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff' });
    createReadStream(path).pipe(res);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '0.0.0.0', () => {
  console.log(`海上营地已就绪\nLocal: http://localhost:${port}`);
  for (const list of Object.values(networkInterfaces())) for (const net of list || []) if (net.family === 'IPv4' && !net.internal) console.log(`Network: http://${net.address}:${port}`);
});
