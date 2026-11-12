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
    seedDemo(g);
    console.log('Preview: http://localhost:' + port);
    console.log('선생님 비밀번호: ' + g.settings_().adminPassword);
    console.log('예시 학생: 뉴턴짱 / 1234 (개념반), 심화러 / 1234 (심화반)');
  });
}
/** 미리보기용 예시 데이터 */
function seedDemo(g) {
  const pw = g.settings_().adminPassword;
  const admin = g.api('adminLogin', null, { password: pw }).token;
  const cls = g.api('publicInfo').classes;
  g.ss.getSheetByName('설정').data.forEach(r => {
    if (r[0] === 'Zoom 링크') r[1] = 'https://zoom.us/j/1234567890';
    if (r[0] === 'Zoom 안내') r[1] = '회의 ID 123 456 7890 · 암호 physics';
  });
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  g.api('lessonSave', admin, { subjectId: cls[0].id, week: today, title: '3강 — 뉴턴의 운동 법칙',
    content: '1. 관성의 법칙\n2. 가속도의 법칙 F = ma\n3. 작용·반작용', videos: '3강 개념 정리 | https://youtu.be/abc123', homework: '교재 p.32~35' });
  g.api('lessonSave', admin, { subjectId: cls[1].id, week: today, title: '3강 — 운동량과 충격량',
    content: '운동량 보존 심화 문제', videos: '심화 풀이 | https://youtu.be/def456', homework: '심화 문제집 5~10번' });
  g.api('noticeSave', admin, { subjectId: '', title: '기말고사 대비 특강 일정', content: '12/20(토) 오후 2시, 전 반 공통', pinned: true });
  g.api('noticeSave', admin, { subjectId: cls[0].id, title: '개념반: 다음 주 월요일 휴강', content: '보강은 금요일 수업 뒤 30분' });
  g.api('noticeSave', admin, { subjectId: cls[1].id, title: '심화반: 교재 변경', content: '새 교재를 가져오세요' });
  g.api('signup', null, { nickname: '뉴턴짱', name: '홍길동', phone: '01012345678', password: '1234', classIds: [cls[0].id] });
  g.api('signup', null, { nickname: '심화러', name: '김철수', phone: '01099990000', password: '1234', classIds: [cls[1].id] });
}

module.exports = { startServer };
