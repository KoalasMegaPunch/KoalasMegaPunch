// Backend logic tests against the mock GAS environment.  Run: node dev/test-api.js
const assert = require('assert');
const { createGas } = require('./mock-gas');

const g = createGas();
let failures = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}
const throws = (fn, re) => assert.throws(fn, e => re.test(e.message));
const settingsSheet = () => g.ss.getSheetByName('설정');
function setSetting(label, value) {
  const sh = settingsSheet();
  sh.data.forEach(r => { if (r[0] === label) r[1] = value; });
}

g.setup();
const adminPw = g.settings_().adminPassword;

t('setup creates all sheets and default subjects', () => {
  ['설정', '학생', '과목', '수업', 'Zoom Clinic 예약', '질문', 'FAQ', 'Zoom Clinic 시간표'].forEach(n => assert(g.ss.getSheetByName(n), n));
  assert.strictEqual(adminPw.length, 8);
});

let s1, s2, admin;
t('signup validates input', () => {
  throws(() => g.api('signup', null, { nickname: 'a', name: '홍길동', phone: '01012345678', password: '1234' }), /닉네임/);
  throws(() => g.api('signup', null, { nickname: '선생님', name: '홍길동', phone: '01012345678', password: '1234' }), /쓸 수 없는/);
  throws(() => g.api('signup', null, { nickname: '뉴턴', name: '홍길동', phone: '1234', password: '1234' }), /휴대폰/);
  throws(() => g.api('signup', null, { nickname: '뉴턴', name: '홍길동', phone: '01012345678', password: '12' }), /비밀번호/);
});
t('signup + login works, phone keeps leading zero', () => {
  s1 = g.api('signup', null, { nickname: '뉴턴짱', name: '홍길동', phone: '010 1234 5678', password: 'abcd' });
  s2 = g.api('signup', null, { nickname: 'einstein', name: '김철수', phone: '010-9999-0000', password: 'pass1' });
  assert.strictEqual(g.ss.getSheetByName('학생').data[1][3], '010-1234-5678');
  throws(() => g.api('signup', null, { nickname: 'EINSTEIN', name: '다른', phone: '01011112222', password: '1234' }), /이미 사용/);
  throws(() => g.api('login', null, { nickname: '뉴턴짱', password: 'wrong' }), /맞지 않아요/);
  const r = g.api('login', null, { nickname: '뉴턴짱', password: 'abcd' });
  assert(r.token && r.me.nickname === '뉴턴짱' && !('phone' in r.me) && !('name' in r.me));
});
t('admin login', () => {
  throws(() => g.api('adminLogin', null, { password: 'nope' }), /맞지 않아요/);
  admin = g.api('adminLogin', null, { password: adminPw }).token;
  assert(g.api('bootstrap', admin).me.role === 'admin');
});
t('auth: bad token rejected, student cannot call admin APIs', () => {
  throws(() => g.api('bootstrap', 'garbage'), /AUTH_REQUIRED/);
  throws(() => g.api('bootstrap', s1.token.replace(/.$/, 'x')), /AUTH_REQUIRED/);
  throws(() => g.api('studentsList', s1.token), /선생님만/);
  throws(() => g.api('subjectSave', s1.token, { name: 'x' }), /선생님만/);
});

let subjects;
t('subjects: rename / add / move / hide', () => {
  subjects = g.api('bootstrap', s1.token).subjects;
  assert.deepStrictEqual(subjects.map(s => s.name), ['겨울특강 물리학 개념(월금)', '겨울특강 물리학 심화(화목)']);
  let list = g.api('subjectSave', admin, { id: subjects[0].id, name: '겨울특강 물리학 개념반(월금)' });
  assert.strictEqual(list[0].name, '겨울특강 물리학 개념반(월금)');
  list = g.api('subjectSave', admin, { name: '화학 특강' });
  assert.strictEqual(list.length, 3);
  list = g.api('subjectMove', admin, { id: list[2].id, dir: -1 });
  assert.strictEqual(list[1].name, '화학 특강');
  list = g.api('subjectSetActive', admin, { id: list[1].id, active: false });
  assert.strictEqual(g.api('bootstrap', s1.token).subjects.length, 2, 'hidden subject not shown to students');
  assert.strictEqual(g.api('bootstrap', admin).subjects.length, 3, 'admin still sees it');
  subjects = g.api('bootstrap', s1.token).subjects;
});

t('lessons: save and list grouped by week', () => {
  g.api('lessonSave', admin, { subjectId: subjects[0].id, week: '2026-11-13', title: '1강', content: '뉴턴 법칙', videos: '1강 영상 | https://youtu.be/abc\njavascript:alert(1)\nhttps://youtu.be/def', homework: 'p.10' });
  g.api('lessonSave', admin, { subjectId: subjects[0].id, week: '2026-11-03', title: '0강', content: 'OT', videos: '', homework: '' });
  const d = g.api('lessonsList', s1.token, { subjectId: subjects[0].id });
  assert.strictEqual(d.lessons.length, 2);
  assert.strictEqual(d.lessons[0].week, '2026-11-09', 'normalized to Monday');
  assert.deepStrictEqual(d.lessons[0].videos.map(v => v.title), ['1강 영상', '수업 영상 3'], 'non-http link dropped');
  assert.strictEqual(d.weeks.length, 2);
  throws(() => g.api('lessonSave', s1.token, { subjectId: subjects[0].id, week: '2026-11-13' }), /선생님만/);
});

t('booking: slots, book, capacity, cancel, timetable', () => {
  const d = g.api('bookingSlots', s1.token);
  assert(d.days.length >= 2, 'has weekend days');
  d.days.forEach(day => assert([0, 6].includes(new Date(day.date + 'T00:00:00Z').getUTCDay())));
  const day = d.days.find(x => x.slots.every(s => s.open));
  assert(day, 'an open day exists');
  assert.deepStrictEqual(day.slots.map(s => s.hour), [19, 20, 21, 22, 23]);
  assert(!('people' in day.slots[0]), 'students never see who booked');

  g.api('bookingBook', s1.token, { date: day.date, hour: 20, memo: '역학 질문' });
  throws(() => g.api('bookingBook', s1.token, { date: day.date, hour: 20 }), /이미 신청/);
  throws(() => g.api('bookingBook', s2.token, { date: day.date, hour: 20 }), /먼저 신청/);
  throws(() => g.api('bookingBook', s2.token, { date: day.date, hour: 18 }), /신청할 수 없는/);
  throws(() => g.api('bookingBook', s2.token, { date: '2020-01-04', hour: 20 }), /신청할 수 없는/);

  const mine = g.api('bookingSlots', s1.token).days.find(x => x.date === day.date).slots.find(s => s.hour === 20);
  assert(mine.mine && mine.count === 1);
  const other = g.api('bookingSlots', s2.token).days.find(x => x.date === day.date).slots.find(s => s.hour === 20);
  assert(!other.mine && other.count === 1);
  const adm = g.api('bookingSlots', admin).days.find(x => x.date === day.date).slots.find(s => s.hour === 20);
  assert.strictEqual(adm.people[0].name, '홍길동');
  assert.strictEqual(adm.people[0].phone, '010-1234-5678');

  const tt = g.ss.getSheetByName('Zoom Clinic 시간표').data;
  const flat = tt.map(r => r.join(' | ')).join('\n');
  assert(flat.includes('홍길동 (뉴턴짱)'), 'timetable sheet lists the booking:\n' + flat);
  assert(flat.includes('20:00~21:00'));

  throws(() => g.api('bookingCancel', s2.token, { id: mine.mine }), /내 예약만/);
  g.api('bookingCancel', s1.token, { id: mine.mine });
  assert(!g.ss.getSheetByName('Zoom Clinic 시간표').data.map(r => r.join('|')).join('\n').includes('홍길동'));
});

t('booking: capacity setting and weekly max', () => {
  setSetting('시간당 정원', '2');
  setSetting('1인 주당 최대 신청(시간)', '1');
  const day = g.api('bookingSlots', s1.token).days.find(x => x.slots.every(s => s.open));
  g.api('bookingBook', s1.token, { date: day.date, hour: 21 });
  g.api('bookingBook', s2.token, { date: day.date, hour: 21 });
  throws(() => g.api('bookingBook', s1.token, { date: day.date, hour: 22 }), /최대 1시간/);
  setSetting('1인 주당 최대 신청(시간)', '0');
  g.api('bookingBook', s1.token, { date: day.date, hour: 22 });
  const tt = g.ss.getSheetByName('Zoom Clinic 시간표').data.map(r => r.join(' | ')).join('\n');
  assert(tt.includes('홍길동 (뉴턴짱)\n김철수 (einstein)') || tt.includes('김철수 (einstein)\n홍길동 (뉴턴짱)'), tt);
  assert.strictEqual(g.api('myInfo', s1.token).bookings.length, 2);
  setSetting('시간당 정원', '1');
});

t('booking: cutoff blocks past slots', () => {
  // Jump the clock to Saturday 20:30 KST of the first open weekend: 19,20 are past, 21 within 1h cutoff → closed.
  const day = g.api('bookingSlots', s1.token).days.find(x => x.slots.every(s => s.open) && new Date(x.date + 'T00:00:00Z').getUTCDay() === 6);
  const target = Date.parse(day.date + 'T20:30:00+09:00');
  g.clock.offsetMs = target - Date.now();
  const slots = g.api('bookingSlots', s1.token).days.find(x => x.date === day.date).slots;
  assert.deepStrictEqual(slots.map(s => s.open), [false, false, false, true, true]);
  throws(() => g.api('bookingBook', s2.token, { date: day.date, hour: 21 }), /지났어요/);
  g.clock.offsetMs = 0;
});

let q1;
t('questions: anonymous, answer, faq', () => {
  g.api('questionCreate', s1.token, { subjectId: subjects[0].id, title: '관성이 뭐예요?', content: '설명해주세요' });
  g.api('questionCreate', s2.token, { subjectId: subjects[0].id, title: '가속도 단위', content: 'm/s^2 맞나요?' });
  throws(() => g.api('questionCreate', s1.token, { subjectId: subjects[0].id, title: '', content: 'x' }), /제목/);
  const asS2 = g.api('questionsList', s2.token, { subjectId: subjects[0].id });
  assert.strictEqual(asS2.length, 2);
  asS2.forEach(q => { assert(!('authorId' in q) && !('asker' in q) && !('nickname' in q)); });
  assert.deepStrictEqual(asS2.map(q => q.mine).sort(), [false, true]);
  q1 = asS2.find(q => !q.mine);
  throws(() => g.api('questionDelete', s2.token, { id: q1.id }), /내 질문만/);
  assert.strictEqual(g.api('bootstrap', admin).unanswered, 2);
  g.api('questionAnswer', admin, { id: q1.id, answer: '물체가 운동 상태를 유지하려는 성질이에요.' });
  assert.strictEqual(g.api('bootstrap', admin).unanswered, 1);
  throws(() => g.api('questionDelete', s1.token, { id: q1.id }), /답변이 달린/);
  const seen = g.api('questionsList', s2.token, { subjectId: subjects[0].id }).find(q => q.id === q1.id);
  assert(seen.answer.includes('운동 상태'));
  g.api('faqFromQuestion', admin, { id: q1.id });
  throws(() => g.api('faqFromQuestion', admin, { id: q1.id }), /이미 FAQ/);
  g.api('faqSave', admin, { subjectId: subjects[0].id, question: '숙제는 어디에 내요?', answer: '수업 시작 전에 걷어요.' });
  const faq = g.api('faqList', s2.token, { subjectId: subjects[0].id });
  assert.deepStrictEqual(faq.map(f => f.question.split('\n')[0]), ['관성이 뭐예요?', '숙제는 어디에 내요?']);
  assert.strictEqual(g.api('faqList', s2.token, { subjectId: subjects[1].id }).length, 0, 'per-subject');
  assert(g.api('questionsList', admin, { subjectId: subjects[0].id }).find(q => q.id === q1.id).inFaq);
});

t('notices: per-class + all-class, pinned first, admin only', () => {
  throws(() => g.api('noticeSave', s1.token, { subjectId: subjects[0].id, title: 'x' }), /선생님만/);
  throws(() => g.api('noticeSave', admin, { subjectId: subjects[0].id, title: '' }), /제목/);
  g.api('noticeSave', admin, { subjectId: subjects[0].id, title: '개념반 휴강', content: '월요일 휴강' });
  g.api('noticeSave', admin, { subjectId: subjects[1].id, title: '심화반 교재', content: '교재 지참' });
  g.api('noticeSave', admin, { subjectId: '', title: '전체: 시험 일정', content: '12/20', pinned: true });
  const a = g.api('noticesList', s1.token, { subjectId: subjects[0].id });
  assert.deepStrictEqual(a.map(n => n.title), ['전체: 시험 일정', '개념반 휴강']);
  assert(a[0].pinned && a[0].scope === '전체 공지');
  const b = g.api('noticesList', s1.token, { subjectId: subjects[1].id });
  assert.deepStrictEqual(b.map(n => n.title).sort(), ['심화반 교재', '전체: 시험 일정'].sort());
  assert.strictEqual(g.api('bootstrap', s1.token).noticeStamps.length, 3);
  g.api('noticeSave', admin, { id: a[1].id, subjectId: subjects[0].id, title: '개념반 휴강(수정)', content: '' });
  g.api('noticeDelete', admin, { id: b.find(n => n.title === '심화반 교재').id });
  assert.strictEqual(g.api('bootstrap', s1.token).noticeStamps.length, 2);
  assert(g.api('noticesList', s1.token, { subjectId: subjects[0].id }).some(n => n.title === '개념반 휴강(수정)'));
});

t('password change invalidates old token; admin reset works', () => {
  const old = s1.token;
  const r = g.api('changePassword', s1.token, { current: 'abcd', next: 'newpw' });
  throws(() => g.api('bootstrap', old), /AUTH_REQUIRED/);
  g.api('bootstrap', r.token);
  const sid = g.api('studentsList', admin).find(u => u.nickname === '뉴턴짱').id;
  const temp = g.api('studentResetPassword', admin, { id: sid }).tempPassword;
  throws(() => g.api('bootstrap', r.token), /AUTH_REQUIRED/);
  s1 = g.api('login', null, { nickname: '뉴턴짱', password: temp });
});

t('admin password change invalidates admin token', () => {
  setSetting('선생님 비밀번호', 'newadminpw');
  throws(() => g.api('bootstrap', admin), /AUTH_REQUIRED/);
  admin = g.api('adminLogin', null, { password: 'newadminpw' }).token;
});

t('student delete removes future bookings', () => {
  const sid = g.api('studentsList', admin).find(u => u.nickname === '뉴턴짱').id;
  g.api('studentDelete', admin, { id: sid });
  throws(() => g.api('bootstrap', s1.token), /AUTH_REQUIRED/);
  assert(!g.ss.getSheetByName('Zoom Clinic 예약').data.some(r => r[4] === '뉴턴짱'));
  assert.strictEqual(g.api('studentsList', admin).length, 1);
});

t('notification emails when configured', () => {
  setSetting('알림 받을 이메일', 'teacher@example.com');
  g.api('questionCreate', s2.token, { subjectId: subjects[0].id, title: '메일 테스트', content: '내용' });
  assert(g.mails.some(m => m.subject.includes('메일 테스트')));
});

t('zoom link only for students with a booking', () => {
  setSetting('Zoom 링크', 'https://zoom.us/j/123');
  setSetting('Zoom 안내', '암호 0000');
  const day = g.api('bookingSlots', s2.token).days.find(x => x.slots.every(s => s.open));
  g.api('bookingBook', s2.token, { date: day.date, hour: 19 });
  assert.strictEqual(g.api('bookingSlots', s2.token).zoomUrl, 'https://zoom.us/j/123');
  assert.strictEqual(g.api('myInfo', s2.token).zoomInfo, '암호 0000');
  const s3 = g.api('signup', null, { nickname: 'nobook', name: '박영희', phone: '01033334444', password: '1234' });
  assert(!('zoomUrl' in g.api('bookingSlots', s3.token)), 'no booking → no zoom link');
  assert(!('zoomUrl' in g.api('myInfo', s3.token)));
  assert.strictEqual(g.api('bookingSlots', admin).zoomUrl, 'https://zoom.us/j/123');
});

t('migrates old 보충 sheets and settings from the previous version', () => {
  const old = createGas();
  const ss = old.ss;
  const set = ss.insertSheet('설정');
  set.data = [['항목', '값', '설명'], ['앱 이름', '옛 앱', ''], ['선생님 비밀번호', 'pw', ''], ['보충 요일', '토', ''], ['보충 시작 시각', '20', ''], ['보충 종료 시각', '22', '']];
  const bk = ss.insertSheet('보충예약');
  bk.data = [['id', '날짜', '시작시각', '학생id', '닉네임', '이름', '전화번호', '메모', '신청일시'], ['b1', '2026-11-14', '20', 'u1', '옛학생', '이순신', '010-1111-2222', '', '2026-11-10 10:00']];
  ss.insertSheet('보충시간표');
  old.refreshTimetable();
  assert(ss.getSheetByName('Zoom Clinic 예약') && !ss.getSheetByName('보충예약'), 'bookings sheet renamed');
  assert(ss.getSheetByName('Zoom Clinic 시간표') && !ss.getSheetByName('보충시간표'), 'timetable renamed');
  const labels = set.data.map(r => r[0]);
  assert(labels.includes('Clinic 요일') && !labels.includes('보충 요일'), labels.join(','));
  assert(labels.includes('Zoom 링크'), 'new setting appended');
  const tt = ss.getSheetByName('Zoom Clinic 시간표').data.map(r => r.join('|')).join('\n');
  assert(tt.includes('이순신 (옛학생)') && tt.includes('20:00~21:00') && !tt.includes('19:00'), tt);
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
