// Minimal in-memory mock of the Google Apps Script services used by src/Code.gs.
// Only for local development/testing — not deployed.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function chainable(target) {
  // Any formatting call we don't care about (setFontWeight, setBorder, ...) is a no-op returning itself.
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      return () => t._self;
    },
  });
}

class MockSheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, (r || []).length), 0); }
  getMaxRows() { return Math.max(1000, this.data.length); }
  getLastRow() {
    for (let r = this.data.length - 1; r >= 0; r--) {
      if ((this.data[r] || []).some(v => v !== '' && v !== undefined && v !== null)) return r + 1;
    }
    return 0;
  }
  getRange(row, col, nr = 1, nc = 1) {
    const sheet = this;
    const range = {
      setValues(vals) {
        vals.forEach((rv, i) => rv.forEach((v, j) => sheet._set(row + i, col + j, v)));
        return range._self;
      },
      setValue(v) { sheet._set(row, col, v); return range._self; },
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const r = [];
          for (let j = 0; j < nc; j++) { const v = (sheet.data[row - 1 + i] || [])[col - 1 + j]; r.push(v === undefined ? '' : v); }
          out.push(r);
        }
        return out;
      },
    };
    range._self = chainable(range);
    return range._self;
  }
  _set(r, c, v) {
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  }
  appendRow(arr) { this.data.push(arr.slice()); }
  deleteRow(r) { this.data.splice(r - 1, 1); }
  clear() { this.data = []; return this; }
  setFrozenRows() {} setFrozenColumns() {} setColumnWidth() {} setColumnWidths() {}
}

class MockSpreadsheet {
  constructor() { this.sheets = []; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n, idx) {
    const s = new MockSheet(n);
    if (typeof idx === 'number') this.sheets.splice(idx, 0, s); else this.sheets.push(s);
    return s;
  }
  getSheets() { return this.sheets; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/MOCK/edit'; }
}

function toSigned(buf) { return Array.from(buf).map(b => (b > 127 ? b - 256 : b)); }
function toBuf(x) { return Array.isArray(x) ? Buffer.from(x.map(b => b & 0xff)) : Buffer.from(String(x), 'utf8'); }

function createGas(opts = {}) {
  const ss = new MockSpreadsheet();
  const props = {};
  const mails = [];
  const clock = { offsetMs: 0 };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + clock.offsetMs); else super(...a); }
    static now() { return RealDate.now() + clock.offsetMs; }
  }
  const tzFmt = (date, tz, fmt) => {
    const parts = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).forEach(p => { parts[p.type] = p.value; });
    return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day).replace('HH', parts.hour).replace('mm', parts.minute);
  };
  const ctx = {
    console,
    Date: FakeDate,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => { throw new Error('no ui'); },
      BorderStyle: { SOLID: 'SOLID' },
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: tzFmt,
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => toSigned(crypto.createHash('sha256').update(String(s), 'utf8').digest()),
      computeHmacSha256Signature: (v, k) => toSigned(crypto.createHmac('sha256', String(k)).update(String(v), 'utf8').digest()),
      base64EncodeWebSafe: x => toBuf(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    MailApp: { sendEmail: (to, subject, body) => { mails.push({ to, subject, body }); } },
    Logger: { log: () => {} },
    HtmlService: {},
  };
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8');
  // Top-level const/let aren't exposed on the context object, so export what the harness needs.
  vm.runInContext(code + '\n;this.__exports = { api, setup, refreshTimetable, settings_: () => settings_() };', ctx);
  const ex = ctx.__exports;
  // google.script.run serializes results as JSON; do the same (also avoids cross-realm objects).
  const api = (...a) => { const r = ex.api(...a); return r === undefined ? r : JSON.parse(JSON.stringify(r)); };
  return { ss, props, mails, clock, ...ex, api };
}

module.exports = { createGas };
