// End-to-end UI walkthrough on a phone viewport.  Run: node dev/e2e.js [screenshotDir]
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { startServer } = require('./server');

(async () => {
  const outDir = process.argv[2] || path.join(__dirname, 'screens');
  fs.mkdirSync(outDir, { recursive: true });
  const { server, g } = await startServer(8799);
  const adminPw = g.settings_().adminPassword;
  const URL = 'http://localhost:8799/';

  // Seed some lesson content as the teacher.
  const admin = g.api('adminLogin', null, { password: adminPw }).token;
  const subs = g.api('bootstrap', admin).subjects;
  g.api('lessonSave', admin, {
    subjectId: subs[0].id, week: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), title: '11/10(월) 3강 — 뉴턴의 운동 법칙',
    content: '1. 관성의 법칙\n2. 가속도의 법칙 F = ma\n3. 작용·반작용\n\n판서 자료: https://example.com/notes.pdf',
    videos: '3강 개념 정리 | https://youtu.be/abc123\n3강 문제풀이 | https://youtu.be/def456',
    homework: '교재 p.32~35 전 문항\n오답노트 3문제 이상',
  });
  g.ss.getSheetByName('설정').data.forEach(r => { if (r[0] === 'Zoom 링크') r[1] = 'https://zoom.us/j/1234567890'; if (r[0] === 'Zoom 안내') r[1] = '회의 ID 123 456 7890 · 암호 physics'; });
  g.api('noticeSave', admin, { subjectId: '', title: '기말고사 대비 특강 일정', content: '12/20(토) 오후 2시, 전 반 공통입니다.', pinned: true });
  g.api('noticeSave', admin, { subjectId: subs[0].id, title: '다음 주 월요일 휴강', content: '보강은 금요일 수업 뒤에 30분 진행해요.' });

  const browser = await chromium.launch();
  const errors = [];
  const shot = async (page, name) => page.screenshot({ path: path.join(outDir, name + '.png') });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/pretendard|net::ERR/i.test(m.text())) errors.push('console: ' + m.text()); });

  // --- Student: signup
  await page.goto(URL);
  await page.getByRole('button', { name: '처음이에요 (가입)' }).click();
  await shot(page, '01-signup');
  await page.getByPlaceholder('예: 뉴턴짱').fill('뉴턴짱');
  await page.getByPlaceholder('실명').fill('홍길동');
  await page.getByPlaceholder('010-1234-5678').fill('01012345678');
  await page.getByPlaceholder('4자 이상').fill('abcd');
  await page.getByPlaceholder('한 번 더').fill('abcd');
  await page.locator('form .chip', { hasText: '개념(월금)' }).click();
  await shot(page, '01-signup');
  await page.getByRole('button', { name: '가입하기' }).click();
  // Lands on 공지 (leftmost tab); opening it marks notices as read.
  await page.getByText('다음 주 월요일 휴강').waitFor();
  if ((await page.locator('nav button').first().getAttribute('data-tab')) !== 'notice') throw new Error('공지 should be the leftmost tab');
  await page.waitForTimeout(300);
  await shot(page, '02b-notices');
  if (await page.locator('nav [data-tab=notice] .dot').count()) throw new Error('unread badge should clear');

  await page.locator('nav [data-tab=lessons]').click();
  await page.getByText('3강 개념 정리').waitFor();
  await shot(page, '02-lessons');

  // --- Booking
  await page.locator('nav [data-tab=booking]').click();
  await page.locator('.slot.free').first().waitFor();
  await shot(page, '03-booking');
  await page.locator('.slot.free').nth(1).click();
  await page.getByPlaceholder('예: 3단원 문제풀이 질문 (선택)').fill('운동량 보존 질문');
  await page.getByRole('button', { name: '신청하기' }).click();
  await page.locator('.slot.mine').first().waitFor();
  await shot(page, '04-booked');

  // --- 동시 신청 상황 재현 (다른 반 학생 = rival 이 서버에서 직접 신청)
  const cls = g.api('publicInfo').classes;
  const rival = g.api('signup', null, { nickname: '라이벌', name: '이경쟁', phone: '01022223333', password: '1234', classIds: [cls[1].id] }).token;
  const freeSlots = page.locator('.slot.free');
  const slotKey = async i => (await freeSlots.nth(i).getAttribute('data-slot')).split(' ');
  // (1) 화면은 '빈 칸'인데 그 사이 rival 이 먼저 신청 → 폼을 열면 바로 경고 + 버튼 비활성
  let [d1, h1] = await slotKey(0);
  assert(g.api('bookingBook', rival, { date: d1, hour: +h1 }).ok);
  await freeSlots.first().click();
  await page.getByText('방금 다른 학생이 이 시간을 먼저 신청했어요').waitFor();
  if (!(await page.getByRole('button', { name: '신청하기' }).isDisabled())) throw new Error('book button should be disabled');
  await shot(page, '04b-race-warning');
  await page.locator('.sheet .btn.line', { hasText: '취소' }).click();
  // (2) 폼을 연 '다음'에 rival 이 신청 → 신청하기를 누르면 거절 안내 + 시간표가 즉시 최신으로
  let [d2, h2] = await slotKey(1);
  await page.locator(`.slot[data-slot="${d2} ${h2}"]`).click();
  await page.waitForTimeout(500);
  assert(g.api('bookingBook', rival, { date: d2, hour: +h2 }).ok);
  await page.getByRole('button', { name: '신청하기' }).click();
  await page.getByText('신청하지 못했어요').waitFor();
  await shot(page, '04c-race-rejected');
  await page.getByRole('button', { name: '다른 시간 고르기' }).click();
  if (!(await page.locator(`.slot.full[data-slot="${d2} ${h2}"]`).count())) throw new Error('slot should now show as full');
  // (3) 가만히 보고 있어도 자동 새로고침으로 마감이 반영됨
  let [d3, h3] = await slotKey(0);
  assert(g.api('bookingBook', rival, { date: d3, hour: +h3 }).ok);
  await page.locator(`.slot.full[data-slot="${d3} ${h3}"]`).waitFor({ timeout: 20000 });
  const rows = g.ss.getSheetByName('Zoom Clinic 예약').data.slice(1);
  const dup = rows.map(r => r[1] + ' ' + r[2]).filter((k, i, a) => a.indexOf(k) !== i);
  if (dup.length) throw new Error('double booking: ' + dup);

  // --- Q&A
  await page.locator('nav [data-tab=qna]').click();
  await page.getByRole('button', { name: '✏️ 질문하기' }).click();
  await page.getByPlaceholder('한 줄 요약').fill('관성이 정확히 뭔가요?');
  await page.locator('.sheet textarea').fill('버스가 출발할 때 몸이 뒤로 쏠리는 게 관성인가요?');
  await shot(page, '05-ask');
  await page.getByRole('button', { name: '익명으로 올리기' }).click();
  await page.locator('.card.q').first().waitFor();
  await shot(page, '06-board');

  // --- Me
  await page.locator('nav [data-tab=me]').click();
  await page.getByText('다가오는 Zoom Clinic').waitFor();
  await shot(page, '07-me');
  await page.getByRole('button', { name: '로그아웃' }).click();

  // --- Teacher
  await page.getByRole('button', { name: '선생님 로그인' }).click();
  await page.getByPlaceholder('[설정] 시트의 선생님 비밀번호').fill(adminPw);
  await page.getByRole('button', { name: '선생님으로 로그인' }).click();
  await page.locator('nav [data-tab=qna] .dot').waitFor();
  await page.locator('nav [data-tab=qna]').click();
  await page.locator('.card.q h3').first().click();
  await page.getByPlaceholder('답변을 입력하세요').fill('맞아요! 정지해 있던 몸이 계속 정지 상태를 유지하려는 성질이 관성이에요.');
  await page.getByRole('button', { name: '답변 등록' }).click();
  await page.waitForTimeout(400);
  await page.locator('.card.q h3').first().click();
  await page.getByRole('button', { name: 'FAQ로 등록' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '자주 묻는 질문' }).click();
  await page.locator('details.faq-item').first().waitFor();
  await page.locator('details.faq-item summary').first().click();
  await shot(page, '08-teacher-faq');

  await page.locator('nav [data-tab=booking]').click();
  await page.locator('.slot.admin-has').first().waitFor();
  await page.locator('.slot.admin-has', { hasText: '홍길동' }).first().click();
  await page.locator('.sheet .badge', { hasText: '개념(월금)' }).waitFor();
  await page.locator('.sheet a[href^="tel:"]').waitFor();
  await shot(page, '09c-teacher-slot-detail');
  await page.getByRole('button', { name: '닫기' }).click();
  await shot(page, '09-teacher-booking');

  await page.locator('nav [data-tab=notice]').click();
  await page.getByRole('button', { name: '+ 공지 쓰기' }).click();
  await page.getByPlaceholder('예: 다음 주 월요일 휴강 안내').fill('심화반 교재 변경');
  await page.locator('.sheet select').selectOption({ label: '겨울특강 물리학 심화(화목)' });
  await page.locator('.sheet textarea').fill('다음 수업부터 새 교재를 가져오세요.');
  await shot(page, '09b-teacher-notice-form');
  await page.getByRole('button', { name: '올리기' }).click();
  await page.getByText('심화반 교재 변경').waitFor();

  await page.locator('nav [data-tab=admin]').click();
  await page.getByText('총 2명').waitFor();
  await page.locator('.list-row .badge', { hasText: '개념(월금)' }).first().waitFor();
  await page.locator('.list-row .icon-btn[title="이름 바꾸기"]').first().click();
  await page.locator('.sheet input').fill('겨울특강 물리학 개념반(월금)');
  await page.getByRole('button', { name: '저장' }).click();
  await page.getByText('겨울특강 물리학 개념반(월금)').first().waitFor();
  await shot(page, '10-teacher-admin');

  // --- Student sees teacher's answer
  await page.getByRole('button', { name: '로그아웃' }).click();
  await page.getByPlaceholder('비밀번호').fill('abcd');
  await page.locator('form button[type=submit]').click();
  await page.locator('nav [data-tab=qna]').click();
  await page.locator('.chip', { hasText: '개념반' }).click();
  await page.locator('.card.q h3').first().click();
  await page.getByText('선생님 답변').waitFor();
  await shot(page, '11-student-answer');

  const timetable = g.ss.getSheetByName('Zoom Clinic 시간표').data.map(r => r.join(' | ')).join('\n');
  console.log('--- Zoom Clinic 시간표 sheet ---\n' + timetable);
  await browser.close();
  server.close();
  if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('E2E OK, screenshots in ' + outDir);
})().catch(e => { console.error(e); process.exit(1); });
