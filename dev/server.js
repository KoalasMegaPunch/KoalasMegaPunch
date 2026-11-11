// Local preview: serves src/Index.html with a google.script.run shim backed by the mock GAS.
// Run: node dev/server.js [port]   → http://localhost:8787
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGas } = require('./mock-gas');

function startServer(port) {
  const g = createGas();
  g.setup();
  const SHIM = `<script>
window.google = { script: { run: (function make(ok, fail) {
  return new Proxy({}, { get(_, name) {
    if (name === 'withSuccessHandler') return fn => make(fn, fail);
    if (name === 'withFailureHandler') return fn => make(ok, fn);
    return (...args) => fetch('/rpc', { method: 'POST', body: JSON.stringify({ name, args }) })
      .then(r => r.json()).then(r => r.error ? fail && fail(new Error(r.error)) : ok && ok(r.result));
  } });
})() } };
</script>`;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/rpc') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const { name, args } = JSON.parse(body);
        let out;
        try { out = { result: g[name](...args) }; } catch (e) { out = { error: e.message }; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'Index.html'), 'utf8').replace('<head>', '<head>' + SHIM);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise(resolve => server.listen(port, () => resolve({ server, g })));
}

if (require.main === module) {
  const port = +process.argv[2] || 8787;
  startServer(port).then(({ g }) => {
    console.log('Preview: http://localhost:' + port);
    console.log('선생님 비밀번호: ' + g.settings_().adminPassword);
  });
}
module.exports = { startServer };
