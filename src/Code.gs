/**
 * 학생용 클래스 앱 — Google Apps Script 백엔드
 *
 * 모든 데이터는 이 스크립트가 연결된 구글 스프레드시트에 저장됩니다.
 *   설정 / 학생 / 과목 / 수업 / 공지 / Zoom Clinic 예약 / Zoom Clinic 시간표 / 질문 / FAQ 시트
 * 학생은 스프레드시트를 볼 수 없고, 앱(웹앱)을 통해서만 데이터에 접근합니다.
 * 학생의 이름·전화번호는 선생님(마스터 계정)에게만 전달됩니다.
 */

const TZ = 'Asia/Seoul';
const TOKEN_DAYS = 60;              // 로그인 유지 기간(일)
const SHOW_ASKER_TO_TEACHER = false; // true로 바꾸면 선생님 화면에서만 질문 작성자 닉네임이 보입니다.
const TIMETABLE_SHEET = 'Zoom Clinic 시간표';
const LEGACY_TIMETABLE_SHEET = '보충시간표'; // 이전 버전 이름
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

const SHEET_DEFS = {
  users: {
    name: '학생',
    fields: ['id', 'nickname', 'name', 'phone', 'pwHash', 'salt', 'createdAt', 'classIds'],
    headers: ['id', '닉네임', '이름', '전화번호', '비밀번호(암호화)', 'salt', '가입일시', '반 id(쉼표 구분)'],
  },
  subjects: {
    name: '과목',
    fields: ['id', 'name', 'order', 'active'],
    headers: ['id', '과목명', '순서', '사용(Y/N)'],
  },
  lessons: {
    name: '수업',
    fields: ['id', 'subjectId', 'week', 'title', 'content', 'videos', 'homework', 'updatedAt'],
    headers: ['id', '과목id', '주차(월요일 날짜)', '제목', '수업내용', '영상링크(줄마다 제목|URL)', '숙제', '수정일시'],
  },
  bookings: {
    name: 'Zoom Clinic 예약',
    legacyName: '보충예약',
    fields: ['id', 'date', 'hour', 'userId', 'nickname', 'name', 'phone', 'memo', 'createdAt', 'className'],
    headers: ['id', '날짜', '시작시각', '학생id', '닉네임', '이름', '전화번호', '메모', '신청일시', '반'],
  },
  questions: {
    name: '질문',
    fields: ['id', 'subjectId', 'authorId', 'title', 'content', 'answer', 'createdAt', 'answeredAt'],
    headers: ['id', '과목id', '작성자id', '제목', '내용', '답변', '작성일시', '답변일시'],
  },
  faq: {
    name: 'FAQ',
    fields: ['id', 'subjectId', 'question', 'answer', 'order', 'sourceId'],
    headers: ['id', '과목id', '질문', '답변', '순서', '원본질문id'],
  },
  notices: {
    name: '공지',
    fields: ['id', 'subjectId', 'title', 'content', 'pinned', 'createdAt', 'updatedAt'],
    headers: ['id', '과목id(비우면 전체)', '제목', '내용', '상단고정(Y/N)', '작성일시', '수정일시'],
  },
  settings: {
    name: '설정',
    fields: ['label', 'value', 'desc'],
    headers: ['항목', '값', '설명'],
  },
};

const SETTING_DEFS = [
  ['appName', '앱 이름', '이어진 물리학', '앱 상단과 브라우저 탭에 표시되는 이름'],
  ['adminPassword', '선생님 비밀번호', '', '선생님(마스터) 로그인 비밀번호. 처음 만들 때 무작위로 정해지니 꼭 바꾸세요.'],
  ['notice', '공지사항', '', '수업 탭 맨 위에 보이는 공지 (비워두면 숨김)'],
  ['zoomUrl', 'Zoom 링크', '', 'Zoom Clinic 입장 주소 (예약한 학생에게만 "Zoom 입장" 버튼으로 보임)'],
  ['zoomInfo', 'Zoom 안내', '', '회의 ID·암호 등 함께 보여줄 안내 (예약한 학생에게만 보임)'],
  ['bookingDays', 'Clinic 요일', '토,일', '쉼표로 구분 (예: 토,일)', '보충 요일'],
  ['bookingStart', 'Clinic 시작 시각', '19', '0~23 (19 = 저녁 7시)', '보충 시작 시각'],
  ['bookingEnd', 'Clinic 종료 시각', '24', '1~24 (24 = 자정). 마지막 Clinic이 이 시각에 끝남', '보충 종료 시각'],
  ['slotCapacity', '시간당 정원', '1', '한 시간에 받을 수 있는 학생 수'],
  ['bookingWeeks', '예약 오픈 주수', '2', '이번 주를 포함해 몇 주 뒤까지 신청을 받을지'],
  ['maxPerWeek', '1인 주당 최대 신청(시간)', '0', '0이면 제한 없음'],
  ['cutoffHours', '신청·취소 마감(시작 N시간 전)', '1', '0이면 수업 시작 직전까지 가능'],
  ['notifyEmail', '알림 받을 이메일', '', '적어두면 Zoom Clinic 신청/취소, 새 질문이 생길 때 메일로 알려줌'],
];

const DEFAULT_SUBJECTS = ['겨울특강 물리학 개념(월금)', '겨울특강 물리학 심화(화목)'];
const RESERVED_NICKNAMES = ['선생님', '관리자', '마스터', '익명', 'admin', 'teacher', 'master'];

let _mem = {}; // 한 번의 요청 동안만 쓰는 캐시

/* =========================================================
 * 웹앱 진입점 / 스프레드시트 메뉴
 * ======================================================= */

function doGet() {
  const name = settings_().appName || '이어진 물리학';
  const out = HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(name)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-capable', 'yes');
  try { out.addMetaTag('apple-mobile-web-app-title', name); } catch (e) { /* 지원 안 되면 무시 (홈 화면 이름은 제목으로 대체) */ }
  return out;
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('학생앱')
    .addItem('초기 설정 (시트 만들기)', 'setup')
    .addItem('Zoom Clinic 시간표 새로고침', 'refreshTimetable')
    .addToUi();
}

/** 메뉴/에디터에서 실행: 필요한 시트를 모두 만들고 선생님 비밀번호를 알려줍니다. */
function setup() {
  _mem = {};
  Object.keys(SHEET_DEFS).forEach(sheet_);
  rebuildTimetable_();
  const s = settings_();
  const msg = '설정 완료!\n\n선생님 비밀번호: ' + s.adminPassword +
    '\n\n[설정] 시트에서 비밀번호와 다른 값들을 바꿀 수 있어요.\n다음 단계: 배포 > 새 배포 > 웹 앱 으로 앱 주소를 만드세요.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* 에디터에서 실행하면 UI가 없음 */ }
}

function refreshTimetable() {
  _mem = {};
  rebuildTimetable_();
}

/* =========================================================
 * API 디스패처 — 클라이언트는 google.script.run.api(action, token, payload) 로 호출
 * ======================================================= */

function api(action, token, payload) {
  _mem = {};
  const h = HANDLERS[action];
  if (!h) throw new Error('알 수 없는 요청입니다: ' + action);
  let ctx = null;
  if (h.auth !== 'public') {
    ctx = auth_(token);
    if (!ctx) throw new Error('AUTH_REQUIRED');
    if (h.auth === 'admin' && ctx.role !== 'admin') throw new Error('선생님만 할 수 있어요.');
  }
  if (!h.write) return h.fn(payload || {}, ctx);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('요청이 많아요. 잠시 후 다시 시도해 주세요.');
  try {
    return h.fn(payload || {}, ctx);
  } finally {
    lock.releaseLock();
  }
}

const HANDLERS = {
  // ---- 공개 ----
  publicInfo: { auth: 'public', fn: () => ({ appName: settings_().appName, classes: activeSubjects_() }) },
  signup: { auth: 'public', write: true, fn: signup_ },
  login: { auth: 'public', fn: login_ },
  adminLogin: { auth: 'public', fn: adminLogin_ },

  // ---- 로그인 사용자 ----
  bootstrap: { auth: 'user', fn: bootstrap_ },
  lessonsList: { auth: 'user', fn: lessonsList_ },
  bookingSlots: { auth: 'user', fn: bookingSlots_ },
  bookingBook: { auth: 'user', write: true, fn: bookingBook_ },
  bookingCancel: { auth: 'user', write: true, fn: bookingCancel_ },
  questionsList: { auth: 'user', fn: questionsList_ },
  questionCreate: { auth: 'user', write: true, fn: questionCreate_ },
  questionDelete: { auth: 'user', write: true, fn: questionDelete_ },
  faqList: { auth: 'user', fn: faqList_ },
  noticesList: { auth: 'user', fn: noticesList_ },
  myInfo: { auth: 'user', fn: myInfo_ },
  changePassword: { auth: 'user', write: true, fn: changePassword_ },
  setMyClasses: { auth: 'user', write: true, fn: setMyClasses_ },

  // ---- 선생님(마스터) ----
  subjectSave: { auth: 'admin', write: true, fn: subjectSave_ },
  subjectMove: { auth: 'admin', write: true, fn: subjectMove_ },
  subjectSetActive: { auth: 'admin', write: true, fn: subjectSetActive_ },
  lessonSave: { auth: 'admin', write: true, fn: lessonSave_ },
  lessonDelete: { auth: 'admin', write: true, fn: lessonDelete_ },
  questionAnswer: { auth: 'admin', write: true, fn: questionAnswer_ },
  faqSave: { auth: 'admin', write: true, fn: faqSave_ },
  faqDelete: { auth: 'admin', write: true, fn: faqDelete_ },
  noticeSave: { auth: 'admin', write: true, fn: noticeSave_ },
  noticeDelete: { auth: 'admin', write: true, fn: noticeDelete_ },
  faqFromQuestion: { auth: 'admin', write: true, fn: faqFromQuestion_ },
  studentsList: { auth: 'admin', fn: studentsList_ },
  studentResetPassword: { auth: 'admin', write: true, fn: studentResetPassword_ },
  studentDelete: { auth: 'admin', write: true, fn: studentDelete_ },
  studentSetClasses: { auth: 'admin', write: true, fn: studentSetClasses_ },
};

/* =========================================================
 * 계정
 * ======================================================= */

function signup_(p) {
  const nickname = clean_(p.nickname, 12);
  const name = clean_(p.name, 20);
  const phone = normalizePhone_(p.phone);
  const password = String(p.password || '');

  if (!/^[0-9A-Za-z가-힣_]{2,12}$/.test(nickname)) throw new Error('닉네임은 2~12자의 한글/영문/숫자/_ 만 쓸 수 있어요.');
  if (RESERVED_NICKNAMES.indexOf(nickname.toLowerCase()) >= 0) throw new Error('쓸 수 없는 닉네임이에요.');
  if (name.length < 2) throw new Error('이름을 정확히 입력해 주세요.');
  if (!phone) throw new Error('휴대폰 번호를 정확히 입력해 주세요. (예: 010-1234-5678)');
  if (password.length < 4) throw new Error('비밀번호는 4자 이상으로 정해 주세요.');
  if (findUserByNickname_(nickname)) throw new Error('이미 사용 중인 닉네임이에요.');
  const classIds = validClassIds_(p.classIds);

  const salt = Utilities.getUuid();
  const user = {
    id: newId_(), nickname, name, phone,
    pwHash: hashPw_(password, salt), salt,
    createdAt: nowStr_(), classIds: classIds.join(','),
  };
  insert_('users', user);
  return { token: makeToken_(user.id, 'student', user.pwHash), me: meOf_(user) };
}

function login_(p) {
  const user = findUserByNickname_(clean_(p.nickname, 12));
  if (!user || hashPw_(String(p.password || ''), user.salt) !== user.pwHash) {
    throw new Error('닉네임 또는 비밀번호가 맞지 않아요.');
  }
  return { token: makeToken_(user.id, 'student', user.pwHash), me: meOf_(user) };
}

function adminLogin_(p) {
  const pw = settings_().adminPassword;
  if (!pw) throw new Error('[설정] 시트에서 선생님 비밀번호를 먼저 정해 주세요.');
  if (String(p.password || '') !== pw) throw new Error('비밀번호가 맞지 않아요.');
  return { token: makeToken_('admin', 'admin', pw), me: { id: 'admin', nickname: '선생님', role: 'admin' } };
}

function bootstrap_(p, ctx) {
  const s = settings_();
  const out = {
    me: ctx.role === 'admin' ? { id: 'admin', nickname: '선생님', role: 'admin' } : meOf_(ctx.user),
    appName: s.appName,
    notice: s.notice,
    subjects: subjectsFor_(ctx),
    noticeStamps: noticeStamps_(ctx),
  };
  if (ctx.role === 'admin') {
    out.sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
    out.unanswered = rows_('questions').filter(q => !q.answer).length;
  }
  return out;
}

function myInfo_(p, ctx) {
  if (ctx.role === 'admin') return { nickname: '선생님', role: 'admin', bookings: [] };
  const u = ctx.user;
  const today = todayStr_();
  const bookings = rows_('bookings')
    .filter(b => b.userId === u.id && b.date >= today)
    .sort(byDateHour_)
    .map(b => ({ id: b.id, date: b.date, hour: +b.hour, label: dateLabel_(b.date) + ' ' + hourLabel_(+b.hour), memo: b.memo }));
  return Object.assign({ nickname: u.nickname, name: u.name, phone: u.phone, createdAt: u.createdAt, bookings }, bookings.length ? zoom_() : {});
}

function changePassword_(p, ctx) {
  if (ctx.role === 'admin') throw new Error('선생님 비밀번호는 [설정] 시트에서 바꿔 주세요.');
  const u = ctx.user;
  if (hashPw_(String(p.current || ''), u.salt) !== u.pwHash) throw new Error('현재 비밀번호가 맞지 않아요.');
  const next = String(p.next || '');
  if (next.length < 4) throw new Error('새 비밀번호는 4자 이상으로 정해 주세요.');
  u.salt = Utilities.getUuid();
  u.pwHash = hashPw_(next, u.salt);
  update_('users', u);
  return { token: makeToken_(u.id, 'student', u.pwHash) };
}

function studentsList_() {
  const counts = {};
  rows_('bookings').forEach(b => { counts[b.userId] = (counts[b.userId] || 0) + 1; });
  return rows_('users')
    .map(u => ({ id: u.id, nickname: u.nickname, name: u.name, phone: u.phone, createdAt: u.createdAt, bookings: counts[u.id] || 0, classIds: classIdsOf_(u) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

/** 선생님: 학생의 반 변경 */
function studentSetClasses_(p) {
  const u = rows_('users').find(x => x.id === p.id);
  if (!u) throw new Error('학생을 찾을 수 없어요.');
  u.classIds = validClassIds_(p.classIds, true).join(',');
  update_('users', u);
  return true;
}

/** 학생: 반이 아직 없을 때(이전 버전에서 가입한 경우) 한 번만 직접 고를 수 있음 */
function setMyClasses_(p, ctx) {
  if (ctx.role === 'admin') throw new Error('선생님 계정은 반을 고르지 않아요.');
  const u = ctx.user;
  if (classIdsOf_(u).length) throw new Error('반 변경은 선생님께 요청해 주세요.');
  u.classIds = validClassIds_(p.classIds).join(',');
  update_('users', u);
  return { me: meOf_(u), subjects: subjectsFor_(ctx) };
}

function classIdsOf_(u) {
  return String((u && u.classIds) || '').split(',').map(x => x.trim()).filter(Boolean);
}

function validClassIds_(ids, allowHidden) {
  const valid = {};
  rows_('subjects').forEach(s => { if (allowHidden || s.active !== 'N') valid[s.id] = true; });
  const out = [].concat(ids || []).map(String).filter((id, i, arr) => valid[id] && arr.indexOf(id) === i);
  if (!out.length) throw new Error('반을 한 개 이상 선택해 주세요.');
  return out;
}

function activeSubjects_() {
  return rows_('subjects').filter(s => s.active !== 'N')
    .sort((a, b) => (+a.order || 0) - (+b.order || 0))
    .map(s => ({ id: s.id, name: s.name }));
}

/** 학생은 자기 반 자료만 볼 수 있음 */
function assertClass_(ctx, subjectId) {
  if (ctx.role === 'admin') return;
  if (classIdsOf_(ctx.user).indexOf(String(subjectId || '')) < 0) throw new Error('내 반의 자료만 볼 수 있어요.');
}

function studentResetPassword_(p) {
  const u = rows_('users').find(x => x.id === p.id);
  if (!u) throw new Error('학생을 찾을 수 없어요.');
  const temp = String(Math.floor(1000 + Math.random() * 9000));
  u.salt = Utilities.getUuid();
  u.pwHash = hashPw_(temp, u.salt);
  update_('users', u);
  return { tempPassword: temp };
}

function studentDelete_(p) {
  const u = rows_('users').find(x => x.id === p.id);
  if (!u) throw new Error('학생을 찾을 수 없어요.');
  const today = todayStr_();
  // 앞으로 있을 Zoom Clinic 예약은 함께 취소
  rows_('bookings').filter(b => b.userId === u.id && b.date >= today).reverse().forEach(b => remove_('bookings', b));
  remove_('users', u);
  rebuildTimetable_();
  return true;
}

/* =========================================================
 * 과목
 * ======================================================= */

function subjectsFor_(ctx) {
  const mine = ctx.role === 'admin' ? null : classIdsOf_(ctx.user);
  return rows_('subjects')
    .filter(s => ctx.role === 'admin' || (s.active !== 'N' && mine.indexOf(s.id) >= 0))
    .sort((a, b) => (+a.order || 0) - (+b.order || 0))
    .map(s => ({ id: s.id, name: s.name, active: s.active !== 'N' }));
}

function subjectSave_(p, ctx) {
  const name = clean_(p.name, 60);
  if (!name) throw new Error('과목명을 입력해 주세요.');
  const all = rows_('subjects');
  if (p.id) {
    const s = all.find(x => x.id === p.id);
    if (!s) throw new Error('과목을 찾을 수 없어요.');
    s.name = name;
    update_('subjects', s);
  } else {
    const maxOrder = all.reduce((m, s) => Math.max(m, +s.order || 0), 0);
    insert_('subjects', { id: newId_(), name, order: String(maxOrder + 1), active: 'Y' });
  }
  return subjectsFor_(ctx);
}

function subjectMove_(p, ctx) {
  const list = rows_('subjects').sort((a, b) => (+a.order || 0) - (+b.order || 0));
  const i = list.findIndex(s => s.id === p.id);
  const j = i + (p.dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return subjectsFor_(ctx);
  const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
  list.forEach((s, k) => {
    if (String(s.order) !== String(k + 1)) { s.order = String(k + 1); update_('subjects', s); }
  });
  return subjectsFor_(ctx);
}

function subjectSetActive_(p, ctx) {
  const s = rows_('subjects').find(x => x.id === p.id);
  if (!s) throw new Error('과목을 찾을 수 없어요.');
  s.active = p.active ? 'Y' : 'N';
  update_('subjects', s);
  return subjectsFor_(ctx);
}

/* =========================================================
 * 수업 (이번 주 수업내용 / 영상 / 숙제)
 * ======================================================= */

function lessonsList_(p, ctx) {
  assertClass_(ctx, p.subjectId);
  const thisWeek = mondayOf_(todayStr_());
  const lessons = rows_('lessons')
    .filter(l => l.subjectId === p.subjectId)
    .map(l => ({
      id: l.id, week: mondayOf_(l.week), title: l.title, content: l.content,
      videos: parseVideos_(l.videos), videosRaw: l.videos, homework: l.homework, updatedAt: l.updatedAt,
    }))
    .sort((a, b) => (a.week === b.week ? a.title.localeCompare(b.title, 'ko') : (a.week < b.week ? 1 : -1)));
  const weeks = [];
  lessons.forEach(l => { if (weeks.indexOf(l.week) < 0) weeks.push(l.week); });
  return {
    thisWeek,
    weeks: weeks.map(w => ({ week: w, label: weekLabel_(w, thisWeek) })),
    lessons,
  };
}

function lessonSave_(p) {
  if (!rows_('subjects').some(s => s.id === p.subjectId)) throw new Error('과목을 선택해 주세요.');
  if (!isYmd_(p.week)) throw new Error('주차(날짜)를 선택해 주세요.');
  const data = {
    subjectId: p.subjectId,
    week: mondayOf_(p.week),
    title: clean_(p.title, 100) || '수업',
    content: String(p.content || '').slice(0, 20000),
    videos: String(p.videos || '').slice(0, 5000),
    homework: String(p.homework || '').slice(0, 10000),
    updatedAt: nowStr_(),
  };
  if (p.id) {
    const l = rows_('lessons').find(x => x.id === p.id);
    if (!l) throw new Error('수업을 찾을 수 없어요.');
    Object.assign(l, data);
    update_('lessons', l);
  } else {
    insert_('lessons', Object.assign({ id: newId_() }, data));
  }
  return true;
}

function lessonDelete_(p) {
  const l = rows_('lessons').find(x => x.id === p.id);
  if (l) remove_('lessons', l);
  return true;
}

function parseVideos_(raw) {
  return String(raw || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, i) => {
    let title = '', url = line;
    const bar = line.lastIndexOf('|');
    if (bar >= 0) { title = line.slice(0, bar).trim(); url = line.slice(bar + 1).trim(); }
    if (!/^https?:\/\//i.test(url)) return null;
    return { title: title || ('수업 영상 ' + (i + 1)), url };
  }).filter(Boolean);
}

/* =========================================================
 * Zoom Clinic 예약 (토·일 저녁 1시간 단위 개인 클리닉)
 * ======================================================= */

function bookingConfig_() {
  const s = settings_();
  const days = String(s.bookingDays || '토,일').split(/[,\s]+/).map(d => DAY_NAMES.indexOf(d.trim().charAt(0))).filter(d => d >= 0);
  const start = clampInt_(s.bookingStart, 0, 23, 19);
  const end = Math.max(start + 1, clampInt_(s.bookingEnd, 1, 24, 24));
  return {
    days: days.length ? days : [6, 0],
    start, end,
    capacity: clampInt_(s.slotCapacity, 1, 50, 1),
    weeks: clampInt_(s.bookingWeeks, 1, 12, 2),
    maxPerWeek: clampInt_(s.maxPerWeek, 0, 100, 0),
    cutoffHours: clampInt_(s.cutoffHours, 0, 72, 1),
  };
}

/** 지금부터 신청 가능한 날짜 목록 (오늘 이후, 설정된 요일, N주) */
function bookingDates_(cfg) {
  const today = todayStr_();
  const monday = mondayOf_(today);
  const out = [];
  for (let w = 0; w < cfg.weeks; w++) {
    for (let k = 0; k < 7; k++) {
      const d = addDays_(monday, w * 7 + k);
      if (d >= today && cfg.days.indexOf(dow_(d)) >= 0) out.push(d);
    }
  }
  return out;
}

function slotOpen_(date, hour, cfg) {
  return minutesOf_(date, hour) - cfg.cutoffHours * 60 > nowMinutes_();
}

function bookingSlots_(p, ctx) {
  const cfg = bookingConfig_();
  const dates = bookingDates_(cfg);
  const isAdmin = ctx.role === 'admin';
  const all = rows_('bookings');
  const days = dates.map(date => {
    const slots = [];
    for (let h = cfg.start; h < cfg.end; h++) {
      const here = all.filter(b => b.date === date && +b.hour === h);
      const mine = isAdmin ? null : here.find(b => b.userId === ctx.user.id);
      const slot = {
        hour: h, label: hourLabel_(h), count: here.length, capacity: cfg.capacity,
        open: slotOpen_(date, h, cfg), mine: mine ? mine.id : null,
      };
      if (isAdmin) slot.people = here.map(b => ({ id: b.id, nickname: b.nickname, name: b.name, phone: b.phone, memo: b.memo, className: b.className }));
      slots.push(slot);
    }
    return { date, label: dateLabel_(date), week: mondayOf_(date), slots };
  });
  const out = {
    days,
    capacity: cfg.capacity,
    maxPerWeek: cfg.maxPerWeek,
    cutoffHours: cfg.cutoffHours,
    rule: cfg.days.map(d => DAY_NAMES[d]).join('·') + ' ' + cfg.start + '~' + cfg.end + '시',
  };
  if (isAdmin) out.sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  const hasMine = days.some(d => d.slots.some(sl => sl.mine));
  if (isAdmin || hasMine) Object.assign(out, zoom_());
  return out;
}

/** Zoom 입장 정보 — 선생님과, 예약이 있는 학생에게만 내려줍니다. */
function zoom_() {
  const s = settings_();
  return { zoomUrl: /^https?:\/\//i.test(s.zoomUrl) ? s.zoomUrl : '', zoomInfo: s.zoomInfo };
}

function bookingBook_(p, ctx) {
  if (ctx.role === 'admin') throw new Error('Zoom Clinic 신청은 학생 계정으로 해 주세요.');
  const cfg = bookingConfig_();
  const date = String(p.date || '');
  const hour = parseInt(p.hour, 10);
  if (bookingDates_(cfg).indexOf(date) < 0 || !(hour >= cfg.start && hour < cfg.end)) throw new Error('신청할 수 없는 시간이에요.');
  if (!slotOpen_(date, hour, cfg)) throw new Error('신청 시간이 지났어요.');

  const all = rows_('bookings');
  const here = all.filter(b => b.date === date && +b.hour === hour);
  if (here.some(b => b.userId === ctx.user.id)) throw new Error('이미 신청한 시간이에요.');
  if (here.length >= cfg.capacity) throw new Error('방금 다른 학생이 먼저 신청했어요. 다른 시간을 골라 주세요.');
  if (cfg.maxPerWeek > 0) {
    const week = mondayOf_(date);
    const n = all.filter(b => b.userId === ctx.user.id && mondayOf_(b.date) === week).length;
    if (n >= cfg.maxPerWeek) throw new Error('한 주에 최대 ' + cfg.maxPerWeek + '시간까지 신청할 수 있어요.');
  }
  const u = ctx.user;
  const myClasses = classIdsOf_(u);
  const classId = p.subjectId && myClasses.indexOf(String(p.subjectId)) >= 0 ? String(p.subjectId) : myClasses[0];
  const cls = rows_('subjects').find(s => s.id === classId);
  const b = {
    id: newId_(), date, hour: String(hour), userId: u.id, nickname: u.nickname, name: u.name, phone: u.phone,
    memo: clean_(p.memo, 200), createdAt: nowStr_(), className: cls ? cls.name : '',
  };
  insert_('bookings', b);
  rebuildTimetable_();
  notify_('[Zoom Clinic 신청] ' + dateLabel_(date) + ' ' + hourLabel_(hour) + ' - ' + u.name,
    (b.className ? '[' + b.className + '] ' : '') + u.name + '(' + u.nickname + ', ' + u.phone + ') 학생이 Zoom Clinic을 신청했어요.\n\n' +
    '일시: ' + dateLabel_(date) + ' ' + hourLabel_(hour) + (b.memo ? '\n메모: ' + b.memo : ''));
  return true;
}

function bookingCancel_(p, ctx) {
  const b = rows_('bookings').find(x => x.id === p.id);
  if (!b) throw new Error('이미 취소된 예약이에요.');
  const isAdmin = ctx.role === 'admin';
  if (!isAdmin) {
    if (b.userId !== ctx.user.id) throw new Error('내 예약만 취소할 수 있어요.');
    if (!slotOpen_(b.date, +b.hour, bookingConfig_())) throw new Error('취소 가능 시간이 지났어요. 선생님께 직접 말씀해 주세요.');
  }
  remove_('bookings', b);
  rebuildTimetable_();
  notify_('[Zoom Clinic 취소] ' + dateLabel_(b.date) + ' ' + hourLabel_(+b.hour) + ' - ' + b.name,
    b.name + '(' + b.nickname + ') 학생의 Zoom Clinic이 ' + (isAdmin ? '선생님에 의해 ' : '') + '취소되었어요.\n\n' +
    '일시: ' + dateLabel_(b.date) + ' ' + hourLabel_(+b.hour));
  return true;
}

/** [Zoom Clinic 시간표] 시트를 시간표 모양으로 다시 그립니다. (이번 주부터) */
function rebuildTimetable_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TIMETABLE_SHEET);
  if (!sh) {
    sh = ss.getSheetByName(LEGACY_TIMETABLE_SHEET);
    if (sh) sh.setName(TIMETABLE_SHEET); else sh = ss.insertSheet(TIMETABLE_SHEET, 0);
  }
  sh.clear();

  const cfg = bookingConfig_();
  const monday = mondayOf_(todayStr_());
  const bookings = rows_('bookings').filter(b => b.date >= monday);
  const dateSet = {};
  bookingDates_(cfg).forEach(d => { dateSet[d] = true; });
  bookings.forEach(b => { dateSet[b.date] = true; });
  const dates = Object.keys(dateSet).sort();
  let start = cfg.start, end = cfg.end;
  bookings.forEach(b => { start = Math.min(start, +b.hour); end = Math.max(end, +b.hour + 1); });

  const cols = dates.length + 1;
  const header = ['시간'].concat(dates.map(dateLabel_));
  const body = [];
  const bgs = [];
  for (let h = start; h < end; h++) {
    const row = [hourLabel_(h)];
    const bg = ['#f3f4f6'];
    dates.forEach(d => {
      const here = bookings.filter(b => b.date === d && +b.hour === h);
      row.push(here.map(b => (b.className ? '[' + b.className + ']\n' : '') + b.name + ' (' + b.nickname + ')\n' + b.phone + (b.memo ? '\n· ' + b.memo : '')).join('\n\n'));
      bg.push(here.length ? (here.length >= cfg.capacity ? '#bfdbfe' : '#dbeafe') : '#ffffff');
    });
    body.push(row);
    bgs.push(bg);
  }

  sh.getRange(1, 1).setValue('Zoom Clinic 시간표  (자동 생성 · 마지막 갱신 ' + nowStr_() + ')').setFontWeight('bold').setFontSize(13);
  if (cols < 2) return;
  sh.getRange(2, 1, 1, cols).setValues([header]).setFontWeight('bold').setBackground('#4f46e5').setFontColor('#ffffff').setHorizontalAlignment('center');
  if (body.length) {
    const r = sh.getRange(3, 1, body.length, cols);
    r.setNumberFormat('@').setValues(body).setBackgrounds(bgs).setWrap(true).setVerticalAlignment('middle').setHorizontalAlignment('center');
    r.setBorder(true, true, true, true, true, true, '#d1d5db', SpreadsheetApp.BorderStyle.SOLID);
    sh.getRange(3, 1, body.length, 1).setFontWeight('bold');
  }
  sh.getRange(body.length + 4, 1).setValue('※ 이 시트는 예약이 바뀔 때마다 자동으로 다시 만들어져요. 직접 고친 내용은 사라집니다. 전체 기록(전화번호 포함)은 [Zoom Clinic 예약] 시트에 있어요.').setFontColor('#6b7280');
  sh.setFrozenRows(2);
  sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 110);
  if (dates.length) sh.setColumnWidths(2, dates.length, 210);
}

/* =========================================================
 * 질문 게시판 / FAQ
 * ======================================================= */

function questionsList_(p, ctx) {
  assertClass_(ctx, p.subjectId);
  const isAdmin = ctx.role === 'admin';
  const faqSources = {};
  rows_('faq').forEach(f => { if (f.sourceId) faqSources[f.sourceId] = true; });
  let nickById = null;
  if (isAdmin && SHOW_ASKER_TO_TEACHER) {
    nickById = {};
    rows_('users').forEach(u => { nickById[u.id] = u.nickname; });
  }
  return rows_('questions')
    .filter(q => q.subjectId === p.subjectId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(q => {
      const o = {
        id: q.id, title: q.title, content: q.content, answer: q.answer,
        createdAt: q.createdAt, answeredAt: q.answeredAt,
        mine: !isAdmin && q.authorId === ctx.user.id,
        inFaq: !!faqSources[q.id],
      };
      if (nickById) o.asker = nickById[q.authorId] || '(탈퇴)';
      return o;
    });
}

function questionCreate_(p, ctx) {
  if (ctx.role === 'admin') throw new Error('질문은 학생 계정으로 올려 주세요. (FAQ는 FAQ 탭에서 직접 추가할 수 있어요)');
  const subject = rows_('subjects').find(s => s.id === p.subjectId && s.active !== 'N');
  if (!subject) throw new Error('과목을 선택해 주세요.');
  assertClass_(ctx, subject.id);
  const title = clean_(p.title, 100);
  const content = String(p.content || '').trim().slice(0, 5000);
  if (!title) throw new Error('제목을 입력해 주세요.');
  if (!content) throw new Error('질문 내용을 입력해 주세요.');
  insert_('questions', {
    id: newId_(), subjectId: subject.id, authorId: ctx.user.id, title, content,
    answer: '', createdAt: nowStr_(), answeredAt: '',
  });
  notify_('[새 질문] ' + subject.name + ' - ' + title, '과목: ' + subject.name + '\n제목: ' + title + '\n\n' + content);
  return true;
}

function questionDelete_(p, ctx) {
  const q = rows_('questions').find(x => x.id === p.id);
  if (!q) return true;
  if (ctx.role !== 'admin') {
    if (q.authorId !== ctx.user.id) throw new Error('내 질문만 삭제할 수 있어요.');
    if (q.answer) throw new Error('답변이 달린 질문은 삭제할 수 없어요.');
  }
  remove_('questions', q);
  return true;
}

function questionAnswer_(p) {
  const q = rows_('questions').find(x => x.id === p.id);
  if (!q) throw new Error('질문을 찾을 수 없어요.');
  q.answer = String(p.answer || '').trim().slice(0, 10000);
  q.answeredAt = q.answer ? nowStr_() : '';
  update_('questions', q);
  return true;
}

/* =========================================================
 * 반별 공지사항
 * ======================================================= */

/** 과목(반) 공지 + 전체 공지. 고정 공지가 먼저, 그다음 최신순. */
function noticesList_(p, ctx) {
  assertClass_(ctx, p.subjectId);
  const subjectNames = {};
  rows_('subjects').forEach(s => { subjectNames[s.id] = s.name; });
  return rows_('notices')
    .filter(n => !n.subjectId || n.subjectId === p.subjectId)
    .sort((a, b) => (a.pinned === 'Y') !== (b.pinned === 'Y') ? (a.pinned === 'Y' ? -1 : 1) : (a.createdAt < b.createdAt ? 1 : -1))
    .map(n => ({
      id: n.id, subjectId: n.subjectId, scope: n.subjectId ? (subjectNames[n.subjectId] || '') : '전체 공지',
      title: n.title, content: n.content, pinned: n.pinned === 'Y', createdAt: n.createdAt, updatedAt: n.updatedAt,
    }));
}

/** 새 공지 표시용: 학생이 볼 수 있는 공지의 (과목, 작성일시) 목록 */
function noticeStamps_(ctx) {
  const visible = {};
  subjectsFor_(ctx).forEach(s => { visible[s.id] = true; });
  return rows_('notices')
    .filter(n => !n.subjectId || visible[n.subjectId])
    .map(n => ({ id: n.id, subjectId: n.subjectId, createdAt: n.createdAt }));
}

function noticeSave_(p) {
  const subjectId = String(p.subjectId || '');
  if (subjectId && !rows_('subjects').some(s => s.id === subjectId)) throw new Error('반(과목)을 선택해 주세요.');
  const title = clean_(p.title, 100);
  const content = String(p.content || '').trim().slice(0, 20000);
  if (!title) throw new Error('제목을 입력해 주세요.');
  const data = { subjectId, title, content, pinned: p.pinned ? 'Y' : 'N', updatedAt: nowStr_() };
  if (p.id) {
    const n = rows_('notices').find(x => x.id === p.id);
    if (!n) throw new Error('공지를 찾을 수 없어요.');
    Object.assign(n, data);
    update_('notices', n);
  } else {
    insert_('notices', Object.assign({ id: newId_(), createdAt: nowStr_() }, data));
  }
  return true;
}

function noticeDelete_(p) {
  const n = rows_('notices').find(x => x.id === p.id);
  if (n) remove_('notices', n);
  return true;
}

function faqList_(p, ctx) {
  assertClass_(ctx, p.subjectId);
  return rows_('faq')
    .filter(f => f.subjectId === p.subjectId)
    .sort((a, b) => (+a.order || 0) - (+b.order || 0))
    .map(f => ({ id: f.id, question: f.question, answer: f.answer, order: f.order }));
}

function faqSave_(p) {
  if (!rows_('subjects').some(s => s.id === p.subjectId)) throw new Error('과목을 선택해 주세요.');
  const question = String(p.question || '').trim().slice(0, 2000);
  const answer = String(p.answer || '').trim().slice(0, 10000);
  if (!question) throw new Error('질문을 입력해 주세요.');
  if (p.id) {
    const f = rows_('faq').find(x => x.id === p.id);
    if (!f) throw new Error('FAQ를 찾을 수 없어요.');
    f.question = question; f.answer = answer;
    update_('faq', f);
  } else {
    insert_('faq', { id: newId_(), subjectId: p.subjectId, question, answer, order: String(nextFaqOrder_(p.subjectId)), sourceId: '' });
  }
  return true;
}

function faqFromQuestion_(p) {
  const q = rows_('questions').find(x => x.id === p.id);
  if (!q) throw new Error('질문을 찾을 수 없어요.');
  if (rows_('faq').some(f => f.sourceId === q.id)) throw new Error('이미 FAQ에 등록된 질문이에요.');
  insert_('faq', {
    id: newId_(), subjectId: q.subjectId, question: q.title + (q.content ? '\n' + q.content : ''),
    answer: q.answer, order: String(nextFaqOrder_(q.subjectId)), sourceId: q.id,
  });
  return true;
}

function faqDelete_(p) {
  const f = rows_('faq').find(x => x.id === p.id);
  if (f) remove_('faq', f);
  return true;
}

function nextFaqOrder_(subjectId) {
  return rows_('faq').filter(f => f.subjectId === subjectId).reduce((m, f) => Math.max(m, +f.order || 0), 0) + 1;
}

/* =========================================================
 * 인증 도우미
 * ======================================================= */

function secret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', s); }
  return s;
}

function sign_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, secret_())).replace(/=+$/, '');
}

/** 토큰 = id~role~만료~서명. 비밀번호가 바뀌면 기존 토큰은 자동으로 무효가 됩니다. */
function makeToken_(id, role, pwKey) {
  const body = [id, role, Date.now() + TOKEN_DAYS * 864e5].join('~');
  return body + '~' + sign_(body + '|' + pwKey);
}

function auth_(token) {
  const parts = String(token || '').split('~');
  if (parts.length !== 4 || +parts[2] < Date.now()) return null;
  const body = parts.slice(0, 3).join('~');
  if (parts[1] === 'admin') {
    const pw = settings_().adminPassword;
    return pw && sign_(body + '|' + pw) === parts[3] ? { role: 'admin' } : null;
  }
  const user = rows_('users').find(u => u.id === parts[0]);
  if (!user || sign_(body + '|' + user.pwHash) !== parts[3]) return null;
  return { role: 'student', user };
}

function hashPw_(pw, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pw, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function findUserByNickname_(nickname) {
  const n = String(nickname || '').toLowerCase();
  return n ? rows_('users').find(u => u.nickname.toLowerCase() === n) : null;
}

function meOf_(u) {
  return { id: u.id, nickname: u.nickname, role: 'student', classIds: classIdsOf_(u) };
}

/* =========================================================
 * 설정
 * ======================================================= */

function settings_() {
  if (_mem.settings) return _mem.settings;
  const sh = sheet_('settings');
  const byLabel = {};
  const rowOf = {};
  const last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 2).getValues().forEach((r, i) => {
      const label = String(r[0]).trim();
      byLabel[label] = r[1];
      rowOf[label] = i + 2;
    });
  }
  const out = {};
  const missing = [];
  SETTING_DEFS.forEach(d => {
    if (!(d[1] in byLabel)) {
      const legacy = d[4];
      if (legacy && legacy in byLabel) {
        // 이전 버전 항목명(예: 보충 요일) → 새 이름으로 바꾸고 값은 그대로 사용
        sh.getRange(rowOf[legacy], 1, 1, 3).setValues([[d[1], String(byLabel[legacy]), d[3]]]);
        byLabel[d[1]] = byLabel[legacy];
      } else {
        byLabel[d[1]] = d[2];
        missing.push([d[1], d[2], d[3]]); // 새 버전에서 추가된 항목은 시트 맨 아래에 추가
      }
    }
    const v = byLabel[d[1]];
    out[d[0]] = v === undefined || v === null ? '' : String(v).trim();
  });
  if (missing.length && last >= 2) {
    sh.getRange(last + 1, 1, missing.length, 3).setNumberFormat('@').setValues(missing);
  }
  if (out.appName === '물리학 클래스' && rowOf['앱 이름']) {
    // 이전 기본값이면 새 이름으로 바꿔 줌
    out.appName = '이어진 물리학';
    sh.getRange(rowOf['앱 이름'], 2).setValue(out.appName);
  }
  _mem.settings = out;
  return out;
}

function initSettings_(sh) {
  const rows = SETTING_DEFS.map(d => [d[1], d[0] === 'adminPassword' ? randomPassword_() : d[2], d[3]]);
  sh.getRange(2, 1, rows.length, 3).setNumberFormat('@').setValues(rows);
  sh.setColumnWidth(1, 220);
  sh.setColumnWidth(2, 220);
  sh.setColumnWidth(3, 480);
}

function randomPassword_() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/* =========================================================
 * 시트 읽기/쓰기
 * ======================================================= */

function sheet_(key) {
  const memKey = 'sheet_' + key;
  if (_mem[memKey]) return _mem[memKey];
  const def = SHEET_DEFS[key];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(def.name);
  if (!sh && def.legacyName) {
    sh = ss.getSheetByName(def.legacyName); // 이전 버전 시트가 있으면 이름만 바꿔서 그대로 사용
    if (sh) sh.setName(def.name);
  }
  if (sh && sh.getLastColumn() < def.headers.length) {
    // 새 버전에서 열이 추가된 경우(예: 학생 '반', 예약 '반') 머리글만 채워 줌
    sh.getRange(1, 1, sh.getMaxRows(), def.headers.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold').setBackground('#eef2ff');
  }
  if (!sh) {
    sh = ss.insertSheet(def.name);
    const n = def.headers.length;
    sh.getRange(1, 1, sh.getMaxRows(), n).setNumberFormat('@'); // 전화번호 앞 0, 날짜 자동변환 방지
    sh.getRange(1, 1, 1, n).setValues([def.headers]).setFontWeight('bold').setBackground('#eef2ff');
    sh.setFrozenRows(1);
    if (key === 'settings') initSettings_(sh);
    if (key === 'subjects') {
      sh.getRange(2, 1, DEFAULT_SUBJECTS.length, 4)
        .setValues(DEFAULT_SUBJECTS.map((name, i) => [newId_(), name, String(i + 1), 'Y']));
    }
  }
  _mem[memKey] = sh;
  return sh;
}

function rows_(key) {
  const memKey = 'rows_' + key;
  if (_mem[memKey]) return _mem[memKey];
  const def = SHEET_DEFS[key];
  const sh = sheet_(key);
  const last = sh.getLastRow();
  const out = [];
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, def.fields.length).getValues().forEach((r, i) => {
      const o = { _row: i + 2 };
      def.fields.forEach((f, j) => { o[f] = cellStr_(r[j]); });
      if (o[def.fields[0]]) out.push(o);
    });
  }
  _mem[memKey] = out;
  return out;
}

function insert_(key, obj) {
  const def = SHEET_DEFS[key];
  const sh = sheet_(key);
  const row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, def.fields.length).setNumberFormat('@')
    .setValues([def.fields.map(f => (obj[f] === undefined || obj[f] === null ? '' : String(obj[f])))]);
  delete _mem['rows_' + key];
}

function update_(key, obj) {
  const def = SHEET_DEFS[key];
  sheet_(key).getRange(obj._row, 1, 1, def.fields.length).setNumberFormat('@')
    .setValues([def.fields.map(f => (obj[f] === undefined || obj[f] === null ? '' : String(obj[f])))]);
}

function remove_(key, obj) {
  sheet_(key).deleteRow(obj._row);
  delete _mem['rows_' + key];
}

function cellStr_(v) {
  if (v instanceof Date) {
    const hasTime = v.getHours() || v.getMinutes();
    return Utilities.formatDate(v, TZ, hasTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
  }
  return v === null || v === undefined ? '' : String(v).trim();
}

/* =========================================================
 * 알림 메일
 * ======================================================= */

function notify_(subject, body) {
  const to = settings_().notifyEmail;
  if (!to) return;
  try {
    MailApp.sendEmail(to, subject, body + '\n\n— ' + (settings_().appName || '학생앱') + ' 자동 알림');
  } catch (e) {
    console.warn('메일 발송 실패: ' + e);
  }
}

/* =========================================================
 * 날짜·문자열 도우미 (모든 날짜는 한국시간 기준 yyyy-MM-dd 문자열)
 * ======================================================= */

function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }
function todayStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function isYmd_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function ymdToMs_(s) { const p = String(s).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
function msToYmd_(ms) { return new Date(ms).toISOString().slice(0, 10); }
function addDays_(s, n) { return msToYmd_(ymdToMs_(s) + n * 864e5); }
function dow_(s) { return new Date(ymdToMs_(s)).getUTCDay(); }
function mondayOf_(s) { return isYmd_(s) ? addDays_(s, -((dow_(s) + 6) % 7)) : s; }
function minutesOf_(date, hour) { return ymdToMs_(date) / 60000 + hour * 60; }
function nowMinutes_() {
  const s = nowStr_(); // yyyy-MM-dd HH:mm
  return minutesOf_(s.slice(0, 10), +s.slice(11, 13)) + +s.slice(14, 16);
}
function dateLabel_(s) {
  const p = String(s).split('-');
  return +p[1] + '/' + +p[2] + ' (' + DAY_NAMES[dow_(s)] + ')';
}
function hourLabel_(h) { return pad2_(h) + ':00~' + pad2_(h + 1) + ':00'; }
function pad2_(n) { return ('0' + n).slice(-2); }
function weekLabel_(monday, thisWeek) {
  const sun = addDays_(monday, 6);
  const fmt = s => +s.slice(5, 7) + '/' + +s.slice(8, 10);
  let tag = '';
  if (monday === thisWeek) tag = ' · 이번 주';
  else if (monday === addDays_(thisWeek, -7)) tag = ' · 지난 주';
  else if (monday === addDays_(thisWeek, 7)) tag = ' · 다음 주';
  return fmt(monday) + ' ~ ' + fmt(sun) + tag;
}
function byDateHour_(a, b) { return a.date === b.date ? +a.hour - +b.hour : (a.date < b.date ? -1 : 1); }
function clampInt_(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return isNaN(n) ? dflt : Math.min(max, Math.max(min, n));
}
function clean_(s, max) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function normalizePhone_(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (!/^01\d{8,9}$/.test(d)) return '';
  return d.length === 11 ? d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7) : d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
}
function newId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 12); }
