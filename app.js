(() => {
'use strict';

/* ============ 常數 ============ */
const LS_SESSIONS = 'tl.sessions.v1';
const LS_META = 'tl.meta.v1';
const EXPORT_APP = 'think-lenses';
const EXPORT_VERSION = 1;

const LENS_COLORS = {
  epictetus: '#6c8796', aristotle: '#b08a2e', kant: '#4f5fb0', mill: '#5a9a58',
  nietzsche: '#b5503c', sartre: '#5c6470', confucius: '#94588c', zhuangzi: '#2f9c8e',
  camus: '#d9812e', wang_yangming: '#a8325f'
};
const VERDICTS = { holds: '仍成立', partly: '部分成立', not: '不成立' };
const CONF_LABELS = ['很不確定', '', '', '', '很確定'];
const QUICK_MAX_CARDS = 5;   // 輕量模式最多看幾個問題
const QUICK_DEPTH = 2;       // 同一個角度最多連問幾題
const ACT_STATUS = { pending: '待回訪', done: '已做', not_yet: '還沒做', not_fit: '不適合' };
const HELP_TEXT = '如果你有傷害自己的念頭，或覺得撐不下去，請現在聯絡身邊信任的人或專業協助。在台灣可撥安心專線 1925，緊急時撥 119。';

/* ============ 小工具 ============ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const nowISO = () => new Date().toISOString();
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
const fmtDateTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : `${fmtDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtYmd = (ymd) => (ymd ? ymd.replace(/-0?/g, '/') : '');

function addMonths(date, m) {
  const x = new Date(date);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + m);
  const last = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
  x.setDate(Math.min(day, last));
  return x;
}

function uid() {
  const d = new Date();
  const buf = new Uint8Array(5);
  (self.crypto || window.crypto).getRandomValues(buf);
  const rand = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${rand}`;
}

let toastTimer;
function toast(msg, opt) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('has-action', !!(opt && opt.onClick));
  if (opt && opt.onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-btn';
    b.textContent = opt.label || '復原';
    b.addEventListener('click', () => { clearTimeout(toastTimer); t.classList.remove('show'); opt.onClick(); });
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), (opt && opt.ms) || 3200);
}

/* ============ 儲存（僅本機 localStorage）============ */
function readJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    console.warn('read failed', key, e);
    return fallback;
  }
}
function writeJSON(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch (e) {
    console.warn('write failed', key, e);
    toast('儲存失敗：瀏覽器可能停用了儲存空間或已滿。請先匯出備份。');
    return false;
  }
}

let pack = null;
let sessions = readJSON(LS_SESSIONS, []);
let meta = readJSON(LS_META, {});
const ui = { sessionId: null, activeLens: {}, rec: null, msg: '', manage: false, picked: new Set(), pendingEnc: null, prepared: null };

const persistSessions = () => writeJSON(LS_SESSIONS, sessions);
const persistMeta = () => writeJSON(LS_META, meta);
const visible = () => sessions.filter((s) => !s.deleted_at);
const byId = (id) => sessions.find((s) => s.id === id && !s.deleted_at);
const lensById = (id) => pack.lenses.find((l) => l.id === id);
const typeById = (id) => pack.stuck_types.find((t) => t.id === id);

/* ============ 加密與 App 鎖 ============ */
const hasCrypto = !!(window.crypto && window.crypto.subtle);
const KDF_ITER = 600000; // 備份加密
const PIN_ITER = 200000; // App 鎖
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = {
  enc(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
};
const AAD = enc.encode('think-lenses|backup|v1');

async function deriveAesKey(pass, salt, iterations) {
  const km = await crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptText(text, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(pass, salt, KDF_ITER);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, enc.encode(text));
  return {
    app: EXPORT_APP, export_version: EXPORT_VERSION, encrypted: true,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITER, salt: b64.enc(salt) },
    cipher: { name: 'AES-GCM', iv: b64.enc(iv) },
    ciphertext: b64.enc(ct)
  };
}
async function decryptEnvelope(env, pass) {
  const k = env && env.kdf;
  const c = env && env.cipher;
  const ok = k && k.name === 'PBKDF2' && k.hash === 'SHA-256' && Number.isInteger(k.iterations) && k.iterations >= 100000 && k.iterations <= 2000000
    && typeof k.salt === 'string' && c && c.name === 'AES-GCM' && typeof c.iv === 'string' && typeof env.ciphertext === 'string';
  if (!ok) throw new Error('format');
  const key = await deriveAesKey(pass, b64.dec(k.salt), k.iterations);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(c.iv), additionalData: AAD }, key, b64.dec(env.ciphertext));
  return dec.decode(pt);
}

const LS_LOCK = 'tl.lock.v1';
const LOCK_TIMEOUTS = [['0', '立即'], ['60', '1 分鐘'], ['300', '5 分鐘'], ['never', '只在重新開啟時']];
let lockCfg = readJSON(LS_LOCK, null);
let locked = !!lockCfg; // 有設定就在啟動時鎖上
let hiddenAt = 0;
async function pinHash(pin, saltB64, iterations) {
  const km = await crypto.subtle.importKey('raw', enc.encode(pin.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return b64.enc(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64.dec(saltB64), iterations }, km, 256));
}
const constEq = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
async function enableLock(pin, timeout) {
  const salt = b64.enc(crypto.getRandomValues(new Uint8Array(16)));
  lockCfg = { salt, iterations: PIN_ITER, hash: await pinHash(pin, salt, PIN_ITER), timeout, fails: 0, until: 0 };
  writeJSON(LS_LOCK, lockCfg);
}
const checkPin = async (pin) => constEq(await pinHash(pin, lockCfg.salt, lockCfg.iterations), lockCfg.hash);
function disableLock() {
  lockCfg = null;
  locked = false;
  try { localStorage.removeItem(LS_LOCK); } catch (e) { /* ignore */ }
}
function cover(on) { document.body.classList.toggle('cover', !!on && meta.cover !== false); }

/* ============ 刪除與復原 ============ */
function deleteSessions(ids) {
  const t = nowISO();
  const stash = [];
  for (const id of ids) {
    const i = sessions.findIndex((s) => s.id === id && !s.deleted_at);
    if (i < 0) continue;
    stash.push(sessions[i]);
    sessions[i] = { id, created_at: sessions[i].created_at, updated_at: t, deleted_at: t };
    if (Q && Q.sessionId === id) Q.sessionId = null;
  }
  if (!stash.length) return 0;
  persistSessions();
  toast(`已刪除 ${stash.length} 則`, { label: '復原', ms: 10000, onClick: () => undoDelete(stash) });
  return stash.length;
}
function undoDelete(stash) {
  const t = nowISO(); // 比墓碑新，才能蓋過已傳到另一台的刪除
  for (const s of stash) {
    const i = sessions.findIndex((x) => x.id === s.id);
    const back = { ...s, updated_at: t };
    if (i >= 0) sessions[i] = back; else sessions.push(back);
  }
  persistSessions();
  toast('已復原');
  route();
}

/* ============ 顏色與排版輔助 ============ */
function lensColor(id) {
  if (LENS_COLORS[id]) return LENS_COLORS[id];
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 48%)`;
}
function paint(root = $('#app')) {
  $$('[data-lens]', root).forEach((el) => el.style.setProperty('--c', lensColor(el.dataset.lens)));
}
function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}

/* ============ 紀錄狀態 ============ */
const hasConclusion = (s) => !!(s.conclusion && String(s.conclusion.judgment || '').trim());
const isDue = (s) => hasConclusion(s) && s.review_at && s.review_at <= localDate(new Date()) && !s.review_result;
const isQuick = (s) => s.mode === 'quick';
const todayStr = () => localDate(new Date());
// 小行動已記下、且不是今天建立的，下次打開就回訪一次
function followUps() {
  return visible()
    .filter((s) => isQuick(s) && s.action && s.action.status === 'pending' && localDate(new Date(s.action.at)) < todayStr())
    .sort((a, b) => b.action.at.localeCompare(a.action.at));
}
function statusOf(s) {
  if (s.mode === 'storm') return { text: s.note ? '有便條' : s.problem ? '只有念頭' : '翻了角度', due: false };
  if (isQuick(s)) {
    const a = s.action;
    if (!a) return { text: '只記了想法', due: false };
    const due = a.status === 'pending' && localDate(new Date(a.at)) < todayStr();
    return { text: due ? '該回訪了' : (ACT_STATUS[a.status] || ''), due };
  }
  if (!hasConclusion(s)) return { text: '未完成', due: false };
  if (s.review_result) return { text: '已回顧', due: false };
  if (isDue(s)) return { text: '該回顧了', due: true };
  return { text: s.review_at ? `${fmtYmd(s.review_at)} 回顧` : '已完成', due: false };
}
const dueList = () => visible().filter(isDue);

/* ============ 畫面骨架 ============ */
function navHTML(active) {
  const dueN = dueList().length + followUps().length;
  const items = [
    ['', '首頁', 'home'],
    ['history', '紀錄', 'history'],
    ['library', '鏡頭', 'library'],
    ['backup', '設定', 'backup']
  ];
  return items
    .map(([href, label, key]) => {
      const pip = key === 'history' && dueN ? '<span class="pip" aria-label="有待回顧"></span>' : '';
      return `<a href="#/${href}"${active === key ? ' aria-current="page"' : ''}>${label}${pip}</a>`;
    })
    .join('');
}
function render(html, { title = '', nav = '' } = {}) {
  $('#app').innerHTML = html;
  document.title = title ? `${title} - 思考鏡頭` : '思考鏡頭';
  $('#nav').innerHTML = navHTML(nav);
  paint();
  $$('textarea', $('#app')).forEach(autosize);
}

/* ============ 路由 ============ */
function route() {
  flushSave();
  if (locked) { viewLock(); return; }
  const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b] = parts;
  window.scrollTo(0, 0);
  if (a !== 'history') { ui.manage = false; ui.picked = new Set(); }
  if (!a) return viewHome();
  if (a === 'unlock') return viewUnlock();
  if (a === 'storm') return viewStorm(b);
  if (a === 'chat') return startChat();
  if (a === 'dose') return viewDose();
  if (a === 'q' && b) return startQuick(b);
  if (a === 'deep') return viewDeepHome();
  if (a === 'help') return viewHelp();
  if (a === 'new' && b) return viewNew(b);
  if (a === 's' && b) return viewSession(b);
  if (a === 'history') return viewHistory();
  if (a === 'library') return viewLibrary();
  if (a === 'lens' && b) return viewLens(b);
  if (a === 'backup') return viewBackup();
  if (a === 'about') return viewAbout();
  location.hash = '#/';
}

/* ============ 首頁 ============ */
const modeLabel = (s) => {
  const id = s.mode === 'quick' ? 'unlock' : s.mode === 'storm' ? 'storm' : 'direction';
  const m = (pack.modes || []).find((x) => x.id === id);
  return m ? m.label : '';
};
function sessionInner(s) {
  const st = statusOf(s);
  const names = s.lenses_used.map((id) => lensById(id)?.name).filter(Boolean).join('、');
  const type = typeById(s.stuck_type)?.label || '';
  return `<span class="clamp">${esc(s.problem || (s.action && s.action.text) || (isQuick(s) ? '解鎖人生' : s.mode === 'storm' ? '腦內風暴' : '（還沒寫下問題）'))}</span>
    <span class="meta"><span>${esc(fmtDate(s.updated_at))}</span><span>${esc(modeLabel(s))}</span>${type ? `<span>${esc(type)}</span>` : ''}${names ? `<span>${esc(names)}</span>` : ''}<span class="badge${st.due ? ' due' : ''}">${esc(st.text)}</span></span>`;
}
const sessionHref = (s) => (s.mode === 'storm' ? `#/storm/${s.id}` : `#/s/${s.id}`);
function sessionRow(s) { return `<a class="row" href="${esc(sessionHref(s))}">${sessionInner(s)}</a>`; }
function pickRow(s) {
  return `<label class="row pickrow"><input type="checkbox" name="pick" value="${esc(s.id)}"${ui.picked.has(s.id) ? ' checked' : ''}><span class="body">${sessionInner(s)}</span></label>`;
}

function modeRow(m) {
  const i = pack.modes.indexOf(m) + 1;
  return `<a class="row entry" href="${esc(m.route)}" data-lens="${esc(m.lens)}"><span class="num" aria-hidden="true">${i}</span><span class="body"><span class="t">${esc(m.label)}</span><span class="h">${esc(m.desc)}</span><span class="eff">${esc(m.effort)}</span></span></a>`;
}

function viewHome() {
  const fu = followUps()[0];
  const dueN = dueList().length;
  const dose = todayDose();
  const dl = lensById(dose.lens);
  const fuBtn = (k, label) => `<button class="btn" data-act="fu" data-id="${esc(fu.id)}" data-s="${k}">${label}</button>`;
  const fuBlock = fu
    ? `<section class="notice"><h3>上次的小行動，做了嗎？</h3><p class="bigact">${esc(fu.action.text)}</p><div class="actions">${fuBtn('done', '做了')}${fuBtn('not_yet', '還沒')}${fuBtn('not_fit', '不適合我')}</div></section>`
    : '';
  const dueLine = dueN ? `<p class="notice small">有 ${dueN} 則「找方向」的紀錄到了回顧時間，<a href="#/history">去看看</a>。</p>` : '';
  render(
    `<header class="hero"><span class="mk" aria-hidden="true"><span class="mk-a"></span><span class="mk-b"></span></span><div><h1 class="brand">思考鏡頭</h1><p class="tagline">${esc(pack.meta.tagline)}</p></div></header>
    <p class="sub">${esc(pack.meta.tagline_sub)}</p>
    ${fuBlock}${dueLine}
    <section class="today" data-lens="${esc(dl.id)}">
      <p class="label">今日一顆</p>
      <p class="angle"><span class="dot"></span>${esc(dl.angle)}</p>
      <p class="todayq">${esc(dl.questions[dose.q])}</p>
      <p class="small"><a href="#/dose">讀完整的一顆</a></p>
    </section>
    <div class="rows">${pack.modes.map(modeRow).join('')}</div>
    <p class="small sub"><a href="#/help">撐不住了？</a>　<a href="#/about">關於</a>${lockCfg ? '　<button class="btn text" data-act="lock-now">鎖定</button>' : ''}</p>`,
    { nav: 'home' }
  );
}

function viewUnlock() {
  const primary = pack.entries.filter((e) => e.primary);
  const more = pack.entries.filter((e) => !e.primary);
  const row = (e) => `<a class="row big" href="#/q/${esc(e.id)}"><span class="t">${esc(e.label)}</span></a>`;
  render(
    `${quickCrumb('<a href="#/">回首頁</a>')}
    <h1>解鎖人生</h1>
    <p class="sub">卡住的時候，不用想清楚。選一個最接近的，讀幾個問題，最後做一件小事。點一下就好，不用打字。</p>
    <div class="rows">${primary.map(row).join('')}</div>
    ${more.length ? `<details class="fold"><summary>更多狀況</summary><div class="rows">${more.map(row).join('')}</div></details>` : ''}`,
    { title: '解鎖人生', nav: 'home' }
  );
}

function viewDeepHome() {
  const due = dueList();
  const drafts = visible().filter((s) => (!s.mode || s.mode === 'deep') && !hasConclusion(s)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 3);
  const dueBlock = due.length
    ? `<section class="notice"><h3>有 ${due.length} 則紀錄到了回顧時間</h3>${due.slice(0, 3).map(sessionRow).join('')}</section>`
    : '';
  const draftBlock = drafts.length
    ? `<h3>還沒寫完的思考</h3><div class="rows">${drafts.map(sessionRow).join('')}</div>`
    : '';
  render(
    `<div class="crumb"><a href="#/">回首頁</a><a href="#/help">撐不住了？</a></div>
    <h1>找方向</h1>
    <p class="sub">面對選擇或岔路時，用立場不同的鏡頭把選項看清楚，並留下你的判斷。需要比較多時間，也會留下完整紀錄。先選最接近的類型。</p>
    ${dueBlock}
    <div class="rows">${pack.stuck_types
      .map((t) => `<a class="row" href="#/new/${esc(t.id)}"><span class="t">${esc(t.label)}</span><span class="h">${esc(t.hint)}</span></a>`)
      .join('')}</div>
    ${draftBlock}`,
    { title: '找方向', nav: 'home' }
  );
}

/* ============ 開始一次思考 ============ */
function recommend(typeId, avoidKey) {
  const fit = new Set(pack.lenses.filter((l) => l.fits.includes(typeId)).map((l) => l.id));
  const pairs = pack.collision_pairs
    .filter((p) => lensById(p.a) && lensById(p.b))
    .map((p) => ({ ...p, score: (fit.has(p.a) ? 1 : 0) + (fit.has(p.b) ? 1 : 0) }))
    .filter((p) => p.score > 0);
  let pool = pairs.filter((p) => p.score === 2);
  if (!pool.length) pool = pairs;
  let choices = pool.filter((p) => `${p.a}|${p.b}` !== avoidKey);
  if (!choices.length) choices = pool;
  if (!choices.length) {
    const ids = Array.from(fit).slice(0, 2);
    return { ids, tension: '', key: ids.join('|') };
  }
  const p = choices[Math.floor(Math.random() * choices.length)];
  return { ids: [p.a, p.b], tension: p.tension, key: `${p.a}|${p.b}` };
}

function vennHTML(ids, tension) {
  const [a, b] = ids.map(lensById);
  if (!a || !b) return '';
  return `<figure class="venn">
    <div class="venn-rings"><span class="ring ring-a" data-lens="${esc(a.id)}">${esc(a.name)}</span><span class="ring ring-b" data-lens="${esc(b.id)}">${esc(b.name)}</span></div>
    ${tension ? `<figcaption>${esc(tension)}</figcaption>` : ''}
  </figure>`;
}

function recBoxHTML(type, rec) {
  const sel = new Set(rec.ids);
  const fitting = pack.lenses.filter((l) => l.fits.includes(type.id));
  const others = pack.lenses.filter((l) => !l.fits.includes(type.id));
  const item = (l) => `<label class="check"><input type="checkbox" name="lens" value="${esc(l.id)}"${sel.has(l.id) ? ' checked' : ''}>
    <span><span class="t"><span class="dot" data-lens="${esc(l.id)}"></span> ${esc(l.name)}</span><span class="h">${esc(l.one_liner)}</span></span></label>`;
  return `${vennHTML(rec.ids, rec.tension)}
    <h3>這類卡住常用的鏡頭</h3><div class="checks">${fitting.map(item).join('')}</div>
    <h3>其他鏡頭</h3><div class="checks">${others.map(item).join('')}</div>`;
}

function viewNew(typeId) {
  const type = typeById(typeId);
  if (!type) { location.hash = '#/'; return; }
  ui.rec = recommend(typeId);
  render(
    `<div class="crumb"><a href="#/deep">回找方向</a></div>
    <h1>${esc(type.label)}</h1>
    <p class="sub">${esc(type.hint)}</p>
    <label class="field" for="problem">用一句話寫下卡住的事</label>
    <textarea id="problem" placeholder="例如：要不要換工作，我怕換了之後後悔"></textarea>
    <h2>這次的鏡頭</h2>
    <p class="sub">立場互相衝突的鏡頭，碰撞出的問題比附和多。想增減可以在下面調整。</p>
    <div id="recBox">${recBoxHTML(type, ui.rec)}</div>
    <div class="actions">
      <button class="btn primary" data-act="start" data-type="${esc(typeId)}">開始思考</button>
      <button class="btn text" data-act="reshuffle" data-type="${esc(typeId)}">換一組</button>
    </div>`,
    { title: type.label, nav: 'home' }
  );
}

function createSession(typeId, problem, lensIds) {
  const t = nowISO();
  const s = {
    id: uid(), created_at: t, updated_at: t, mode: 'deep', problem, stuck_type: typeId,
    lenses_used: lensIds, pack_version: pack.meta.version, answers: [],
    conclusion: { judgment: '', next_step: '', confidence: null },
    review_at: null, review_result: null
  };
  sessions.push(s);
  persistSessions();
  return s;
}

/* ============ 鏡頭卡 ============ */
function listHTML(items) {
  return `<ul>${(items || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
}

function answerOf(s, lens, kind, i) {
  const a = s.answers.find((x) => x.lens === lens && (x.kind || 'question') === kind && (kind !== 'question' || x.question_index === i));
  return a ? a.my_answer : '';
}
function setAnswer(s, lens, kind, i, text) {
  const idx = s.answers.findIndex((x) => x.lens === lens && (x.kind || 'question') === kind && (kind !== 'question' || x.question_index === i));
  if (!text.trim()) {
    if (idx >= 0) s.answers.splice(idx, 1);
    return;
  }
  if (idx >= 0) s.answers[idx].my_answer = text;
  else {
    const a = { lens, kind, my_answer: text };
    if (kind === 'question') a.question_index = i;
    s.answers.push(a);
  }
}

function lensCardHTML(l, s) {
  const box = (kind, i, label) => {
    if (!s) return '';
    return `<textarea data-f="answer" data-l="${esc(l.id)}" data-kind="${kind}" data-i="${i}" aria-label="${esc(label)}" placeholder="寫下你的想法（只存在這台裝置）">${esc(answerOf(s, l.id, kind, i))}</textarea>`;
  };
  return `<article class="lens" data-lens="${esc(l.id)}">
    <header>
      <h2>${esc(l.name)}<span class="en">${esc(l.name_en)}</span></h2>
      <p class="tradition">${esc(l.tradition)}　${esc(l.years)}</p>
    </header>
    <p class="oneliner">${esc(l.one_liner)}</p>
    <p class="claim">${esc(l.core_claim)}</p>
    <h3>問自己</h3>
    ${l.questions.map((q, i) => `<div class="qa"><p class="q">${esc(q)}</p>${box('question', i, q)}</div>`).join('')}
    <h3>思想實驗</h3>
    <p>${esc(l.thought_experiment)}</p>
    ${box('experiment', 0, '思想實驗的想法')}
    <h3>今天可以做的小行動</h3>
    <p>${esc(l.micro_action)}</p>
    ${box('action', 0, '小行動的記錄')}
    <section class="caution">
      <h3>這面鏡頭的盲點</h3>${listHTML(l.blind_spots)}
      <h3>不適用的情況</h3>${listHTML(l.not_suitable_when)}
    </section>
    <p class="reading">延伸閱讀：${esc((l.reading || []).join('、'))}</p>
    <p class="foot">以上是整理者的詮釋，不是哲學家的原話。引用請回到原典。</p>
  </article>`;
}

/* ============ 思考頁（編輯）============ */
function sessionHTML(s) {
  const type = typeById(s.stuck_type);
  const lensIds = s.lenses_used.filter(lensById);
  const active = ui.activeLens[s.id];
  const unused = pack.lenses.filter((l) => !lensIds.includes(l.id));
  const pair = lensIds.length === 2 ? pack.collision_pairs.find((p) => lensIds.includes(p.a) && lensIds.includes(p.b)) : null;
  const c = s.conclusion || {};
  const r = s.review_result || {};
  const reviewHint = s.review_at ? `預計 ${fmtYmd(s.review_at)} 回頭看。` : '寫下判斷後，會自動預設三個月後回頭看。';
  return `<div class="crumb"><a href="#/history">${esc(type ? type.label : '紀錄')}</a><span class="savestate" id="saveState">已儲存在這台裝置</span></div>
    ${s.action ? `<h2>小行動</h2><p class="bigact">${esc(s.action.text)}</p><div class="seg" role="radiogroup" aria-label="小行動狀態">${Object.entries(ACT_STATUS)
      .map(([k, v]) => `<label><input type="radio" name="actstatus" value="${k}"${s.action.status === k ? ' checked' : ''}><span>${v}</span></label>`)
      .join('')}</div>` : ''}
    <label class="field" for="problem">卡住的事${isQuick(s) ? '（選填）' : ''}</label>
    <textarea id="problem" data-f="problem" placeholder="用一句話描述">${esc(s.problem)}</textarea>
    ${pair ? vennHTML([pair.a, pair.b], pair.tension) : ''}
    ${lensIds.length ? `<div class="tabs" role="tablist">${lensIds
      .map((id) => `<button class="tab" role="tab" data-act="tab" data-id="${esc(id)}" data-lens="${esc(id)}" aria-selected="${id === active}"><span class="dot" data-lens="${esc(id)}"></span>${esc(lensById(id).name)}</button>`)
      .join('')}</div>
    <div id="panel">${lensCardHTML(lensById(active), s)}</div>` : '<p class="sub">這則紀錄用到的鏡頭已不在內容包裡。可以在下面加入新的鏡頭。</p>'}
    ${unused.length ? `<details><summary>再加一面鏡頭</summary><div class="actions"><select id="addLens" aria-label="選擇鏡頭">${unused.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select><button class="btn" data-act="add-lens">加入</button></div></details>` : ''}

    <h2>我的結論</h2>
    <p class="sub">不必完美，寫下現在的判斷。之後會回頭檢查。</p>
    <label class="field" for="judgment">現在的判斷</label>
    <textarea id="judgment" data-f="judgment">${esc(c.judgment)}</textarea>
    <label class="field" for="next_step">下一步</label>
    <textarea id="next_step" data-f="next_step">${esc(c.next_step)}</textarea>
    <label class="field" id="confLabel">有多確定</label>
    <div class="seg" role="radiogroup" aria-labelledby="confLabel">${[1, 2, 3, 4, 5]
      .map((n) => `<label><input type="radio" name="confidence" value="${n}"${c.confidence === n ? ' checked' : ''}><span>${n}</span></label>`)
      .join('')}</div>
    <div class="seg-hint"><span>${CONF_LABELS[0]}</span><span>${CONF_LABELS[4]}</span></div>
    <label class="field" for="review_at">什麼時候回頭看</label>
    <input type="date" id="review_at" data-f="review_at" value="${esc(s.review_at || '')}">

    <h2>回顧</h2>
    <p class="sub">${esc(reviewHint)}到時候回答：當時的判斷，現在看起來如何？哪些條件變了？</p>
    <div class="seg" role="radiogroup" aria-label="回顧結果">${Object.entries(VERDICTS)
      .map(([k, v]) => `<label><input type="radio" name="verdict" value="${k}"${r.verdict === k ? ' checked' : ''}><span>${v}</span></label>`)
      .join('')}</div>
    <label class="field" for="review_note">原因與觀察</label>
    <textarea id="review_note" data-f="review_note">${esc(r.note || '')}</textarea>

    <div class="actions">
      <a class="btn primary" href="#/">回到首頁</a>
      <button class="btn danger" data-act="delete">刪除這則紀錄</button>
    </div>`;
}

function viewSession(id) {
  const s = byId(id);
  if (!s) { toast('找不到這則紀錄'); location.hash = '#/history'; return; }
  if (s.mode === 'storm') { location.hash = `#/storm/${id}`; return; }
  ui.sessionId = id;
  const ids = s.lenses_used.filter(lensById);
  if (!ids.includes(ui.activeLens[id])) ui.activeLens[id] = ids[0];
  s.conclusion = s.conclusion || { judgment: '', next_step: '', confidence: null };
  render(sessionHTML(s), { title: '思考', nav: 'history' });
}

/* —— 自動儲存 —— */
let saveTimer = null;
function setSaveState(t) { const el = $('#saveState'); if (el) el.textContent = t; }
function touch(s) {
  s.updated_at = nowISO();
  setSaveState('儲存中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; if (persistSessions()) setSaveState('已儲存在這台裝置'); }, 350);
}
function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; persistSessions(); }
}

function setReview(s, patch) {
  const prev = s.review_result || {};
  const r = { verdict: '', note: '', ...prev, ...patch };
  if (!r.verdict && !String(r.note).trim()) { s.review_result = null; return; }
  r.at = prev.at || nowISO();
  s.review_result = r;
}

function onInput(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.f === 'qnote') { onQuickNote(t); return; }
  if (t.dataset.f === 'storm-thought' || t.dataset.f === 'storm-note') { onStormInput(t); return; }
  if (t.getAttribute('name') === 'pick') {
    if (t.checked) ui.picked.add(t.value); else ui.picked.delete(t.value);
    const n = $('#pickN');
    if (n) n.textContent = `已選 ${ui.picked.size} 則`;
    const d = $('#delPicked');
    if (d) d.disabled = !ui.picked.size;
    return;
  }
  const isRadio = ['confidence', 'verdict', 'actstatus'].includes(t.getAttribute('name'));
  const f = t.dataset.f;
  if (!f && !isRadio) return;
  const s = byId(ui.sessionId);
  if (!s) return;
  if (t.tagName === 'TEXTAREA') autosize(t);
  s.conclusion = s.conclusion || { judgment: '', next_step: '', confidence: null };
  if (isRadio) {
    if (t.name === 'confidence') s.conclusion.confidence = Number(t.value);
    else if (t.name === 'actstatus') { if (s.action) { s.action.status = t.value; s.action.checked_at = nowISO(); } }
    else setReview(s, { verdict: t.value });
  } else if (f === 'problem') s.problem = t.value;
  else if (f === 'answer') setAnswer(s, t.dataset.l, t.dataset.kind, Number(t.dataset.i), t.value);
  else if (f === 'judgment') {
    s.conclusion.judgment = t.value;
    if (t.value.trim() && !s.review_at) {
      s.review_at = localDate(addMonths(new Date(), 3));
      const d = $('#review_at');
      if (d) d.value = s.review_at;
    }
  } else if (f === 'next_step') s.conclusion.next_step = t.value;
  else if (f === 'review_at') s.review_at = t.value || null;
  else if (f === 'review_note') setReview(s, { note: t.value });
  else return;
  touch(s);
}

/* ============ 輕量模式 ============ */
let Q = null;
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const quickPool = () => pack.lenses.filter((l) => l.quick_ok).map((l) => l.id);

function visitLens(id) {
  const l = lensById(id);
  const idx = (l.quick_questions && l.quick_questions.length ? l.quick_questions : l.questions.map((_, i) => i)).filter((i) => i < l.questions.length);
  const start = Math.floor(Math.random() * idx.length);
  const order = idx.map((_, i) => idx[(start + i) % idx.length]);
  const v = { lens: id, order, shown: 0 };
  Q.visits.push(v);
  Q.cur = v;
}

function startQuick(entryId) {
  const entry = (pack.entries || []).find((e) => e.id === entryId);
  if (!entry) { location.hash = '#/'; return; }
  let pool = (entry.lenses || []).filter((id) => lensById(id) && lensById(id).quick_ok);
  if (!pool.length) pool = shuffle(quickPool());
  const k = Math.floor(Math.random() * Math.min(3, pool.length));
  pool = [pool[k], ...pool.filter((_, i) => i !== k)];
  Q = { entry, pool, visits: [], cards: 1, cur: null, sessionId: null, reactions: [], actionLens: null, size: 'normal', screen: 'card' };
  visitLens(pool[0]);
  renderQuick();
}

function switchLens() {
  const used = new Set(Q.visits.map((v) => v.lens));
  const free = Q.pool.filter((id) => !used.has(id));
  if (!free.length) return false;
  const cur = Q.cur.lens;
  const partner = pack.collision_pairs.map((p) => (p.a === cur ? p.b : p.b === cur ? p.a : null)).find((id) => id && free.includes(id));
  visitLens(partner || free[0]);
  Q.cards++;
  return true;
}
function recordReaction(reaction) {
  const v = Q.cur;
  Q.reactions.push({ lens: v.lens, kind: 'question', question_index: v.order[v.shown], reaction });
}
function goAction(lensId) { Q.actionLens = lensId; Q.size = 'normal'; Q.screen = 'action'; renderQuick(); }
function qNext() {
  recordReaction('next');
  const v = Q.cur;
  if (Q.cards >= QUICK_MAX_CARDS) return goAction(v.lens);
  if (v.shown + 1 < Math.min(QUICK_DEPTH, v.order.length)) { v.shown++; Q.cards++; return renderQuick(); }
  if (!switchLens()) return goAction(v.lens);
  renderQuick();
}
function qSwitch() {
  recordReaction('switch');
  if (Q.cards >= QUICK_MAX_CARDS) return goAction(Q.cur.lens);
  if (!switchLens()) { toast('這個狀況的角度先看到這裡，來做一件小事吧。'); return goAction(Q.cur.lens); }
  renderQuick();
}
function qAct() { recordReaction('act'); goAction(Q.cur.lens); }

const actionText = () => {
  const l = lensById(Q.actionLens);
  return Q.size === 'small' && l.micro_action_small ? l.micro_action_small : l.micro_action;
};
function ensureQuickSession() {
  const ids = Q.visits.map((v) => v.lens);
  let s = Q.sessionId && byId(Q.sessionId);
  if (!s) {
    const t = nowISO();
    s = {
      id: uid(), created_at: t, updated_at: t, mode: 'quick', entry: Q.entry.id, stuck_type: Q.entry.type || '', problem: '',
      lenses_used: ids, pack_version: pack.meta.version, answers: [], reactions: [], action: null,
      conclusion: { judgment: '', next_step: '', confidence: null }, review_at: null, review_result: null
    };
    sessions.push(s);
    Q.sessionId = s.id;
  }
  s.lenses_used = ids;
  return s;
}
function saveAction() {
  const s = ensureQuickSession();
  s.reactions = Q.reactions.slice();
  s.action = { lens: Q.actionLens, text: actionText(), size: Q.size, status: 'pending', at: nowISO() };
  s.updated_at = nowISO();
  persistSessions();
  Q.screen = 'done';
  renderQuick();
}
function onQuickNote(t) {
  if (!Q || Q.screen !== 'card') return;
  autosize(t);
  const s = ensureQuickSession();
  const v = Q.cur;
  setAnswer(s, v.lens, 'question', v.order[v.shown], t.value);
  touch(s);
}

const trailHTML = () => `<div class="trail" aria-hidden="true">${Q.visits
  .map((x, i) => `<span class="r${i === Q.visits.length - 1 ? ' now' : ''}" data-lens="${esc(x.lens)}"></span>`)
  .join('')}</div>`;
const quickCrumb = (left) => `<div class="crumb">${left}<a href="#/help">撐不住了？</a></div>`;

function cardHTML() {
  const v = Q.cur;
  const l = lensById(v.lens);
  const qIdx = v.order[v.shown];
  const last = Q.cards >= QUICK_MAX_CARDS;
  const s = Q.sessionId ? byId(Q.sessionId) : null;
  return `${quickCrumb('<a href="#/unlock">重選</a>')}
    ${trailHTML()}
    ${Q.cards === 1 && Q.entry.note ? `<p class="sub">${esc(Q.entry.note)}</p>` : ''}
    <p class="angle" data-lens="${esc(l.id)}"><span class="dot"></span>${esc(l.angle)}</p>
    <p class="bigq">${esc(l.questions[qIdx])}</p>
    <button class="btn primary block" data-act="${last ? 'q-act' : 'q-next'}">${last ? '給我一個行動' : '下一個問題'}</button>
    ${last ? '' : '<div class="actions center"><button class="btn text" data-act="q-switch">換個角度</button><button class="btn text" data-act="q-act">我想行動了</button></div>'}
    <details class="fold"><summary>想寫下來（選填）</summary><textarea data-f="qnote" aria-label="想寫下來" placeholder="只存在這台裝置">${esc(s ? answerOf(s, l.id, 'question', qIdx) : '')}</textarea></details>
    <details class="fold"><summary>這個角度的限制</summary>${listHTML(l.blind_spots)}<p class="small sub">不適用的情況：${esc((l.not_suitable_when || []).join('；'))}</p></details>
    <p class="credit small sub">這個角度來自${esc(l.name)}。內容是整理者的詮釋，不是原話。</p>`;
}
function actionHTML() {
  const l = lensById(Q.actionLens);
  const ids = [...new Set(Q.visits.map((v) => v.lens))];
  return `${quickCrumb('<a href="#/unlock">重選</a>')}
    ${trailHTML()}
    <h1>今天只做這一件事</h1>
    <p class="bigq">${esc(actionText())}</p>
    <p class="small sub">來自「${esc(l.angle)}」。做不到也沒關係，小一點就好。</p>
    <button class="btn primary block" data-act="a-accept">好，我來做</button>
    <div class="actions center">
      ${Q.size === 'normal' && l.micro_action_small ? '<button class="btn text" data-act="a-small">太大了，換小一點</button>' : ''}
      ${ids.length > 1 ? '<button class="btn text" data-act="a-other">換一個行動</button>' : ''}
    </div>`;
}
function doneHTML() {
  return `${quickCrumb('<a href="#/">回首頁</a>')}
    <h1>已記下</h1>
    <p class="bigq">${esc(actionText())}</p>
    <p class="sub">明天起，打開時我會問你做了沒。</p>
    <a class="btn primary block" href="#/">回首頁</a>
    <p class="small"><a href="#/s/${esc(Q.sessionId)}">補充這次的想法</a></p>`;
}
function renderQuick() {
  window.scrollTo(0, 0);
  if (Q.screen === 'action') return render(actionHTML(), { title: '小行動', nav: 'home' });
  if (Q.screen === 'done') return render(doneHTML(), { title: '已記下', nav: 'home' });
  render(cardHTML(), { title: '輕量思考', nav: 'home' });
}

/* ============ 補充觀點：今日一顆 ============ */
// 把可用的(鏡頭 × 溫和問題)輪流排列，同一面鏡頭不會連續出現；每天固定一顆
function dosePool() {
  const lists = pack.lenses
    .filter((l) => l.quick_ok)
    .map((l) => ({ lens: l.id, idx: (l.quick_questions && l.quick_questions.length ? l.quick_questions : l.questions.map((_, i) => i)).filter((i) => i < l.questions.length) }));
  const max = Math.max(0, ...lists.map((x) => x.idx.length));
  const out = [];
  for (let r = 0; r < max; r++) for (const x of lists) if (r < x.idx.length) out.push({ lens: x.lens, q: x.idx[r] });
  return out;
}
const dayNumber = (d = new Date()) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
function todayDose() {
  const pool = dosePool();
  return pool[dayNumber() % pool.length];
}
function markSeen(lensId) {
  meta.seen = meta.seen || {};
  meta.seen[lensId] = localDate(new Date());
  persistMeta();
}
let D = null;
function doseCardHTML(d) {
  const l = lensById(d.lens);
  return `<article class="lens dose" data-lens="${esc(l.id)}">
    <p class="angle"><span class="dot"></span>${esc(l.angle)}</p>
    <p class="story">${esc(l.core_claim)}</p>
    <p class="askq">${esc(l.questions[d.q])}</p>
    <details class="fold"><summary>這個角度的限制</summary>${listHTML(l.blind_spots)}<p class="small sub">不適用的情況：${esc((l.not_suitable_when || []).join('；'))}</p></details>
    <p class="small sub">這個角度來自${esc(l.name)}。內容是整理者的詮釋，不是原話。</p>
  </article>`;
}
function renderDose() {
  const ids = [...new Set(dosePool().map((x) => x.lens))];
  const seen = ids.filter((id) => meta.seen && meta.seen[id]);
  render(
    `${quickCrumb('<a href="#/">回首頁</a>')}
    <h1>補充觀點</h1>
    <p class="sub">每天一顆，不用輸入。慢慢累積你看事情的角度。</p>
    <p class="label">${D.extra ? '再來一顆' : '今日一顆'}</p>
    ${doseCardHTML(D.cur)}
    <div class="actions"><button class="btn" data-act="dose-more">再來一顆</button><a class="btn text" href="#/library">瀏覽全部鏡頭</a></div>
    <h3>你的角度</h3>
    <div class="shelf" aria-hidden="true">${ids.map((id) => `<span class="r${meta.seen && meta.seen[id] ? ' seen' : ''}" data-lens="${esc(id)}"></span>`).join('')}</div>
    <p class="small sub">已讀過 ${seen.length} / ${ids.length} 個角度。</p>`,
    { title: '補充觀點', nav: 'home' }
  );
}
function viewDose() {
  D = { cur: todayDose(), extra: false };
  markSeen(D.cur.lens);
  renderDose();
}
function doseMore() {
  const pool = dosePool().filter((x) => !(x.lens === D.cur.lens && x.q === D.cur.q));
  D = { cur: pool[Math.floor(Math.random() * pool.length)], extra: true };
  markSeen(D.cur.lens);
  renderDose();
}

/* ============ 聊聊而已：不寫入任何紀錄 ============ */
let C = null;
const chatStories = () => (pack.chats || []).filter((c) => lensById(c.lens) && lensById(c.lens).quick_ok);
function startChat() {
  C = { order: shuffle(chatStories()), i: 0, ended: false };
  renderChat();
}
function renderChat() {
  window.scrollTo(0, 0);
  const crumb = quickCrumb('<a href="#/">回首頁</a>');
  if (C.ended || C.i >= C.order.length) {
    render(
      `${crumb}
      <h1>夠了，今天這樣就好。</h1>
      <p class="sub">${C.i >= C.order.length && !C.ended ? '今天的故事聽完了。' : ''}這裡沒有留下任何紀錄。</p>
      <a class="btn primary block" href="#/">回首頁</a>
      <p class="small"><button class="btn text" data-act="chat-restart">再聽一輪</button></p>`,
      { title: '聊聊而已', nav: 'home' }
    );
    return;
  }
  const c = C.order[C.i];
  render(
    `${crumb}
    <p class="angle" data-lens="${esc(c.lens)}"><span class="dot"></span>${esc(c.title)}</p>
    <p class="story">${esc(c.story)}</p>
    <p class="askq">${esc(c.ask)}</p>
    <button class="btn primary block" data-act="chat-next">有意思，再聽一個</button>
    <div class="actions center"><button class="btn text" data-act="chat-stop">夠了，謝謝</button></div>
    <details class="fold"><summary>出處與說明</summary><p class="small sub">${esc(c.source)}。內容由整理者改寫，不是原文。</p></details>
    <p class="credit small sub">這裡不用打字，也不會留下任何紀錄。</p>`,
    { title: '聊聊而已', nav: 'home' }
  );
}

/* ============ 腦內風暴：一個念頭，4 個角度，一張便條 ============ */
let S = null;
function pickQuestion(lensId, avoid) {
  const l = lensById(lensId);
  const all = (l.quick_questions && l.quick_questions.length ? l.quick_questions : l.questions.map((_, i) => i)).filter((i) => i < l.questions.length);
  const opts = all.filter((i) => i !== avoid);
  const arr = opts.length ? opts : all;
  return arr[Math.floor(Math.random() * arr.length)];
}
// 先取一組立場對撞的鏡頭，其餘隨機補到 4 個
function stormPickCards() {
  const pool = quickPool();
  const pairs = pack.collision_pairs.filter((p) => pool.includes(p.a) && pool.includes(p.b));
  let ids = [];
  if (pairs.length) { const p = pairs[Math.floor(Math.random() * pairs.length)]; ids = [p.a, p.b]; }
  ids = ids.concat(shuffle(pool.filter((id) => !ids.includes(id)))).slice(0, 4);
  return ids.map((id) => ({ lens: id, question_index: pickQuestion(id) }));
}
function ensureStormSession() {
  let s = S.id && byId(S.id);
  if (!s) {
    const t = nowISO();
    s = {
      id: uid(), created_at: t, updated_at: t, mode: 'storm', problem: '', note: '', cards: [], stuck_type: '', lenses_used: [],
      pack_version: pack.meta.version, answers: [], conclusion: { judgment: '', next_step: '', confidence: null }, review_at: null, review_result: null
    };
    sessions.push(s);
    S.id = s.id;
    ui.sessionId = s.id;
  }
  s.cards = S.cards.slice();
  s.lenses_used = [...new Set(S.cards.map((c) => c.lens))];
  return s;
}
function stormHTML(s) {
  const flipped = S.cards.length > 0;
  const cards = S.cards.map((c, i) => {
    const l = lensById(c.lens);
    if (!l) return '';
    return `<article class="stormcard" data-lens="${esc(l.id)}"><p class="angle"><span class="dot"></span>${esc(l.angle)}</p><p class="stormq">${esc(l.questions[c.question_index] || '')}</p><button class="btn text" data-act="storm-swap" data-i="${i}">換一個</button></article>`;
  }).join('');
  return `${quickCrumb('<a href="#/">回首頁</a>')}
    <h1>腦內風暴</h1>
    <p class="sub">丟進一個念頭，我翻出幾個不同角度的問題。沒有念頭，也可以先翻翻看。</p>
    <label class="field" for="thought">一個念頭（選填）</label>
    <textarea id="thought" data-f="storm-thought" placeholder="一個煩惱、一件想做的事、腦袋裡的一句話…">${esc(s ? s.problem : '')}</textarea>
    ${flipped ? '' : '<button class="btn primary block" data-act="storm-flip">翻出 4 個角度</button>'}
    ${flipped
      ? `<div class="stormcards">${cards}</div>
         <div class="actions"><button class="btn" data-act="storm-flip">再翻一組</button></div>
         <label class="field" for="stormNote">便條紙</label>
         <textarea id="stormNote" data-f="storm-note" placeholder="想到什麼就記，不用整理">${esc(s ? s.note : '')}</textarea>
         <p class="small sub">只存在這台裝置。這些角度來自不同的哲學家，內容是整理者的詮釋，不是原話。</p>`
      : ''}
    ${s ? '<div class="actions"><button class="btn danger" data-act="delete">刪除這則紀錄</button></div>' : ''}`;
}
function renderStorm(s) {
  render(stormHTML(s), { title: '腦內風暴', nav: 'home' });
}
function viewStorm(id) {
  let s = null;
  if (id) {
    s = byId(id);
    if (!s || s.mode !== 'storm') { toast('找不到這則紀錄'); location.hash = '#/history'; return; }
  }
  S = { id: s ? s.id : null, cards: s ? (s.cards || []).filter((c) => lensById(c.lens)) : [] };
  ui.sessionId = S.id;
  renderStorm(s);
}
function onStormInput(t) {
  if (!S) return;
  autosize(t);
  const s = ensureStormSession();
  if (t.dataset.f === 'storm-thought') s.problem = t.value; else s.note = t.value;
  touch(s);
}

/* ============ 紀錄列表 ============ */
function viewHistory() {
  const list = visible().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (!list.length) ui.manage = false;
  const manage = ui.manage;
  const bar = manage
    ? `<div class="managebar"><button class="btn text" data-act="pick-all">全選</button><span id="pickN" class="sub">已選 ${ui.picked.size} 則</span><span class="grow"></span><button class="btn danger" id="delPicked" data-act="delete-picked"${ui.picked.size ? '' : ' disabled'}>刪除所選</button><button class="btn text" data-act="manage-off">完成</button></div>`
    : '';
  render(
    `<div class="titlebar"><h1>紀錄</h1>${list.length && !manage ? '<button class="btn text" data-act="manage-on">整理</button>' : ''}</div>
    ${list.length
      ? `<p class="sub">共 ${list.length} 則，只存在這台裝置。</p>${bar}<div class="rows">${list.map(manage ? pickRow : sessionRow).join('')}</div>`
      : `<p class="sub">還沒有紀錄。從<a href="#/">首頁</a>選一個狀況開始。</p>`}`,
    { title: '紀錄', nav: 'history' }
  );
}

/* ============ 鏡頭庫 ============ */
function viewLibrary() {
  render(
    `<h1>鏡頭</h1>
    <p class="sub">每位哲學家是一面鏡頭，用他的提問換個角度看自己的事。</p>
    <div class="rows">${pack.lenses
      .map((l) => `<a class="row" href="#/lens/${esc(l.id)}" data-lens="${esc(l.id)}"><span class="t name"><span class="dot"></span>${esc(l.name)}</span><span class="h">${esc(l.tradition)}</span><span class="h">${esc(l.one_liner)}</span></a>`)
      .join('')}</div>
    <h2>鏡頭之間的拉扯</h2>
    <div class="rows">${pack.collision_pairs
      .map((p) => {
        const a = lensById(p.a), b = lensById(p.b);
        return a && b ? `<div class="row"><span class="t">${esc(a.name)} 對 ${esc(b.name)}</span><span class="h">${esc(p.tension)}</span></div>` : '';
      })
      .join('')}</div>`,
    { title: '鏡頭', nav: 'library' }
  );
}

function viewLens(id) {
  const l = lensById(id);
  if (!l) { location.hash = '#/library'; return; }
  const types = l.fits.map(typeById).filter(Boolean);
  const pairs = (l.pairs_with || []).map(lensById).filter(Boolean);
  render(
    `<div class="crumb"><a href="#/library">回鏡頭列表</a></div>
    ${lensCardHTML(l, null)}
    <h3>適合的卡住類型</h3>
    <div class="rows">${types.map((t) => `<a class="row" href="#/new/${esc(t.id)}"><span class="t">${esc(t.label)}</span></a>`).join('')}</div>
    ${pairs.length ? `<h3>可以拿來對撞的鏡頭</h3><p>${pairs.map((p) => `<a href="#/lens/${esc(p.id)}">${esc(p.name)}</a>`).join('、')}</p>` : ''}`,
    { title: l.name, nav: 'library' }
  );
}

/* ============ 備份與同步 ============ */
function buildExport() {
  return { app: EXPORT_APP, export_version: EXPORT_VERSION, exported_at: nowISO(), pack_version: pack.meta.version, sessions };
}
function exportFileName(encrypted) {
  const d = new Date();
  return `think-lenses-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${encrypted ? '-encrypted' : ''}.json`;
}
function markExported() {
  meta.last_export = nowISO();
  persistMeta();
  const el = $('#lastExport');
  if (el) el.textContent = fmtDateTime(meta.last_export);
}
const encState = () => ({
  on: !!($('#encOn') && $('#encOn').checked),
  p1: $('#encPass') ? $('#encPass').value : '',
  p2: $('#encPass2') ? $('#encPass2').value : ''
});
const fingerprint = (st) => `${sessions.length}|${sessions.reduce((m, s) => (s.updated_at > m ? s.updated_at : m), '')}|${st.p1}`;

// 回傳 { text, name }；驗證失敗回傳 null(已提示)
async function preparePayload() {
  flushSave();
  const st = encState();
  if (!st.on) return { text: JSON.stringify(buildExport(), null, 2), name: exportFileName(false) };
  if (!hasCrypto) { toast('這個環境不支援加密（需要 HTTPS），請先取消「加密備份檔」。'); return null; }
  if (st.p1.length < 8) { toast('備份密語至少 8 個字元'); $('#encPass').focus(); return null; }
  if (st.p1 !== st.p2) { toast('兩次輸入的密語不一樣'); $('#encPass2').focus(); return null; }
  const fp = fingerprint(st);
  if (ui.prepared && ui.prepared.fp === fp && Date.now() - ui.prepared.at < 120000) return ui.prepared;
  toast('加密中…', { ms: 20000 });
  try {
    const env = await encryptText(JSON.stringify(buildExport(), null, 2), st.p1);
    ui.prepared = { text: JSON.stringify(env, null, 2), name: exportFileName(true), fp, at: Date.now() };
    $('#toast').classList.remove('show');
    return ui.prepared;
  } catch (e) {
    toast('加密失敗，請改用不加密的備份。');
    return null;
  }
}
// 密語輸入完成時先在背景加密好：這樣按「分享」時不必再等待(部分瀏覽器要求分享必須立刻發生在點擊之後)
async function prepareQuiet() {
  const st = encState();
  if (!st.on || !hasCrypto || st.p1.length < 8 || st.p1 !== st.p2) return;
  try {
    const env = await encryptText(JSON.stringify(buildExport(), null, 2), st.p1);
    ui.prepared = { text: JSON.stringify(env, null, 2), name: exportFileName(true), fp: fingerprint(st), at: Date.now() };
  } catch (e) { /* ignore */ }
}

async function shareExport() {
  const cached = ui.prepared && ui.prepared.fp === fingerprint(encState());
  const p = await preparePayload();
  if (!p) return;
  const file = new File([p.text], p.name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '思考鏡頭備份' });
      markExported();
    } catch (e) {
      if (e.name === 'NotAllowedError' && !cached) toast('已準備好備份，請再按一次「分享或儲存備份檔」');
      else if (e.name !== 'AbortError') toast('無法開啟分享，請改用「下載備份檔」');
    }
  } else toast('這個瀏覽器不支援分享檔案，請改用「下載備份檔」');
}
async function downloadExport() {
  const p = await preparePayload();
  if (!p) return;
  const blob = new Blob([p.text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = p.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  markExported();
}
async function copyExport() {
  const cached = ui.prepared && ui.prepared.fp === fingerprint(encState());
  const p = await preparePayload();
  if (!p) return;
  try {
    await navigator.clipboard.writeText(p.text);
    markExported();
    toast('已複製備份文字');
  } catch (e) { toast(cached ? '無法複製，請改用下載或分享' : '已準備好備份，請再按一次「複製備份文字」'); }
}

const str = (v, d = '') => (typeof v === 'string' ? v : d);
function validSession(x) {
  return x && typeof x === 'object' && typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 100
    && typeof x.updated_at === 'string' && !isNaN(Date.parse(x.updated_at))
    && typeof x.created_at === 'string' && !isNaN(Date.parse(x.created_at));
}
function normalizeAction(a, fallbackAt) {
  if (!a || typeof a !== 'object') return null;
  const at = typeof a.at === 'string' && !isNaN(Date.parse(a.at)) ? a.at : fallbackAt;
  return { lens: str(a.lens), text: str(a.text), size: str(a.size, 'normal'), status: ACT_STATUS[a.status] ? a.status : 'pending', at, checked_at: str(a.checked_at) };
}
function normalize(x) {
  if (x.deleted_at) return { id: x.id, created_at: x.created_at, updated_at: x.updated_at, deleted_at: str(x.deleted_at) };
  const c = x.conclusion && typeof x.conclusion === 'object' ? x.conclusion : {};
  const conf = Number(c.confidence);
  const quickExtra = x.mode === 'quick'
    ? {
        mode: 'quick',
        entry: str(x.entry),
        action: normalizeAction(x.action, x.updated_at),
        reactions: Array.isArray(x.reactions) ? x.reactions.filter((r) => r && typeof r.lens === 'string' && typeof r.reaction === 'string') : []
      }
    : {};
  const stormExtra = x.mode === 'storm'
    ? {
        mode: 'storm',
        note: str(x.note),
        cards: Array.isArray(x.cards) ? x.cards.filter((c) => c && typeof c.lens === 'string' && Number.isInteger(c.question_index)) : []
      }
    : {};
  return {
    ...x,
    ...quickExtra,
    ...stormExtra,
    problem: str(x.problem),
    stuck_type: str(x.stuck_type),
    lenses_used: Array.isArray(x.lenses_used) ? x.lenses_used.filter((v) => typeof v === 'string') : [],
    pack_version: str(x.pack_version),
    answers: Array.isArray(x.answers)
      ? x.answers.filter((a) => a && typeof a.lens === 'string' && typeof a.my_answer === 'string')
      : [],
    conclusion: { judgment: str(c.judgment), next_step: str(c.next_step), confidence: conf >= 1 && conf <= 5 ? conf : null },
    review_at: typeof x.review_at === 'string' && x.review_at ? x.review_at : null,
    review_result: x.review_result && typeof x.review_result === 'object'
      ? { verdict: str(x.review_result.verdict), note: str(x.review_result.note), at: str(x.review_result.at) }
      : null
  };
}
function importData(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { error: '內容不是有效的 JSON。' }; }
  if (!data || data.app !== EXPORT_APP || !Array.isArray(data.sessions)) return { error: '這不是「思考鏡頭」的備份檔。' };
  if (Number(data.export_version) > EXPORT_VERSION) return { error: '這個備份檔來自較新的版本，請先更新 app 再匯入。' };
  const r = { added: 0, updated: 0, skipped: 0, invalid: 0 };
  for (const inc of data.sessions) {
    if (!validSession(inc)) { r.invalid++; continue; }
    const i = sessions.findIndex((s) => s.id === inc.id);
    if (i < 0) { sessions.push(normalize(inc)); r.added++; }
    else if (Date.parse(inc.updated_at) > Date.parse(sessions[i].updated_at)) { sessions[i] = normalize(inc); r.updated++; }
    else r.skipped++;
  }
  persistSessions();
  return r;
}
function handleImport(text) {
  let probe = null;
  try { probe = JSON.parse(text); } catch (e) { /* 交給 importData 回報 */ }
  if (probe && probe.app === EXPORT_APP && probe.encrypted === true) {
    ui.pendingEnc = text;
    ui.msg = '';
    viewBackup();
    toast('這是加密的備份檔，請輸入密語');
    return;
  }
  const r = importData(text);
  ui.msg = r.error
    ? `匯入失敗：${r.error}`
    : `匯入完成：新增 ${r.added} 則、更新 ${r.updated} 則、沒有變動 ${r.skipped} 則${r.invalid ? `、略過無效資料 ${r.invalid} 筆` : ''}。`;
  toast(ui.msg);
  viewBackup();
}
async function decryptImport() {
  const pass = $('#impPass') ? $('#impPass').value : '';
  if (!pass) { toast('請輸入備份密語'); return; }
  if (!hasCrypto) { toast('這個環境不支援解密（需要 HTTPS）'); return; }
  try {
    const text = await decryptEnvelope(JSON.parse(ui.pendingEnc), pass);
    ui.pendingEnc = null;
    handleImport(text);
  } catch (e) {
    toast(e && e.message === 'format' ? '加密備份檔的格式不正確。' : '密語不正確，或檔案已損毀。');
  }
}

function lockSectionHTML() {
  const opts = (sel) => LOCK_TIMEOUTS.map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('');
  if (!lockCfg) {
    return `<p class="sub">開啟後，每次開啟 app、或離開一段時間再回來，都要輸入 PIN 或密碼。這是一道遮罩，用來擋住隨手點開的人，<strong>不是加密</strong>：資料仍以明文存在這個瀏覽器裡。</p>
    <label class="field" for="lockNew">設定 PIN 或密碼（至少 4 個字元）</label>
    <input type="password" id="lockNew" autocomplete="new-password">
    <label class="field" for="lockNew2">再輸入一次</label>
    <input type="password" id="lockNew2" autocomplete="new-password">
    <label class="field" for="lockTimeout">自動鎖定</label>
    <select id="lockTimeout">${opts('60')}</select>
    <div class="actions"><button class="btn" data-act="lock-on"${hasCrypto ? '' : ' disabled'}>開啟 App 鎖</button></div>
    <p class="small sub">忘記 PIN 時，唯一的辦法是清除這台裝置的所有紀錄，再用備份檔還原。${hasCrypto ? '' : '（這個環境不支援，需要 HTTPS。）'}</p>`;
  }
  return `<p>App 鎖已開啟。這是遮罩，不是加密。</p>
    <label class="field" for="lockTimeout">自動鎖定</label>
    <select id="lockTimeout">${opts(String(lockCfg.timeout))}</select>
    <div class="actions"><button class="btn" data-act="lock-now">立即鎖定</button></div>
    <label class="field" for="lockCur">要關閉 App 鎖，請先輸入目前的 PIN 或密碼</label>
    <input type="password" id="lockCur" autocomplete="off">
    <div class="actions"><button class="btn danger" data-act="lock-off">關閉 App 鎖</button></div>`;
}

function viewBackup() {
  const all = visible();
  const done = all.filter(hasConclusion).length;
  const stale = all.length > 0 && (!meta.last_export || Date.now() - Date.parse(meta.last_export) > 30 * 864e5);
  const msg = ui.msg ? `<p class="notice" role="status">${esc(ui.msg)}</p>` : '';
  ui.msg = '';
  const encOn = meta.enc !== false && hasCrypto;
  const pending = ui.pendingEnc
    ? `<section class="notice"><h3>這是加密的備份檔</h3>
        <label class="field" for="impPass">輸入備份密語</label>
        <input type="password" id="impPass" autocomplete="off">
        <div class="actions"><button class="btn primary" data-act="import-decrypt">解密並匯入</button><button class="btn text" data-act="import-cancel">取消</button></div></section>`
    : '';
  render(
    `<h1>備份與保護</h1>
    <p class="sub">紀錄只存在這台裝置的瀏覽器裡，沒有上傳到任何地方。要在手機和 Mac 之間帶著走，就用備份檔。</p>
    ${msg}${pending}
    <div class="panel"><dl>
      <dt>紀錄</dt><dd>${all.length} 則（已寫結論 ${done} 則）</dd>
      <dt>上次匯出</dt><dd id="lastExport">${meta.last_export ? esc(fmtDateTime(meta.last_export)) : '還沒有'}</dd>
      <dt>持久儲存</dt><dd id="persistState">檢查中…</dd>
    </dl></div>
    ${stale ? '<p>已經一段時間沒有備份了，建議現在匯出一次。</p>' : ''}
    <h2>匯出</h2>
    <label class="check"><input type="checkbox" id="encOn"${encOn ? ' checked' : ''}${hasCrypto ? '' : ' disabled'}><span><span class="t">加密備份檔</span><span class="h">備份會經過 iCloud、AirDrop、訊息等地方，建議加密。${hasCrypto ? '' : '（這個環境不支援，需要 HTTPS。）'}</span></span></label>
    <div id="encBox"${encOn ? '' : ' hidden'}>
      <label class="field" for="encPass">備份密語（至少 8 個字元）</label>
      <input type="password" id="encPass" autocomplete="new-password">
      <label class="field" for="encPass2">再輸入一次</label>
      <input type="password" id="encPass2" autocomplete="new-password">
      <p class="small sub">密語不會被儲存。忘記密語，這個備份檔就無法開啟，也沒有任何辦法救回。建議用幾個詞組成的長密語。</p>
    </div>
    <div class="actions">
      <button class="btn primary" data-act="share">分享或儲存備份檔</button>
      <button class="btn" data-act="download">下載備份檔</button>
      <button class="btn" data-act="copy">複製備份文字</button>
    </div>
    <h2>匯入</h2>
    <p class="sub">匯入是合併，不會整批覆蓋：同一則紀錄只保留比較新的版本。加密的備份檔會要求輸入密語。</p>
    <div class="actions">
      <label class="btn">選擇備份檔<input class="hidden-input" type="file" id="importFile" accept=".json,application/json,text/plain"></label>
    </div>
    <label class="field" for="pasteBox">或貼上備份文字</label>
    <textarea id="pasteBox" placeholder="貼上從另一台裝置複製的備份文字"></textarea>
    <div class="actions"><button class="btn" data-act="paste-import">匯入貼上的文字</button></div>
    <h2>保護</h2>
    <h3>App 鎖</h3>
    ${lockSectionHTML()}
    <h3>背景遮蔽</h3>
    <label class="check"><input type="checkbox" id="coverOn"${meta.cover !== false ? ' checked' : ''}><span><span class="t">切到背景時遮蔽畫面</span><span class="h">避免多工切換畫面或旁人看到內容。效果依手機系統而定。</span></span></label>
    <h2>兩台裝置之間</h2>
    <ol>
      <li>在一台裝置按「分享或儲存備份檔」，存到 iCloud 雲碟，或用 AirDrop、訊息傳給自己。</li>
      <li>在另一台按「選擇備份檔」匯入。</li>
      <li>需要反向時，再做一次。因為是合併，兩邊都有新紀錄也不會互相覆蓋。</li>
    </ol>
    <p class="small sub">刪除也會跟著備份傳遞：在一台刪掉的紀錄，匯入到另一台後也會被刪除。但已經匯出的備份檔、其他地方的副本不會自動消失，需要你自己刪。</p>
    <h2>儲存空間</h2>
    <p class="sub">瀏覽器在空間不足時，可能清掉網站資料。請求持久儲存可以降低這個風險，但仍然不能取代備份。</p>
    <div class="actions"><button class="btn" data-act="persist">請求持久儲存</button></div>
    <h2>清除</h2>
    <div class="actions"><button class="btn danger" data-act="clear-all">清除這台裝置的所有紀錄</button></div>`,
    { title: '備份與保護', nav: 'backup' }
  );
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((p) => { const el = $('#persistState'); if (el) el.textContent = p ? '已啟用' : '未啟用'; });
  } else { const el = $('#persistState'); if (el) el.textContent = '此瀏覽器不支援'; }
}

/* ============ 鎖定畫面 ============ */
function viewLock() {
  $('#nav').innerHTML = '';
  document.title = '思考鏡頭';
  $('#app').innerHTML = `<h1>思考鏡頭</h1>
    <p class="sub">已鎖定。${hasCrypto ? '輸入 PIN 或密碼解鎖。' : '這個環境無法驗證 PIN（需要 HTTPS）。'}</p>
    <label class="field" for="pin">PIN 或密碼</label>
    <input type="password" id="pin" autocomplete="off">
    <p id="lockMsg" class="small sub" role="status"></p>
    <button class="btn primary block" data-act="unlock">解鎖</button>
    <p class="small"><button class="btn text" data-act="forgot-pin">忘記了？</button></p>`;
  const pin = $('#pin');
  if (pin) pin.focus();
}
async function tryUnlock() {
  const msg = $('#lockMsg');
  const say = (m) => { if (msg) msg.textContent = m; };
  const pin = $('#pin') ? $('#pin').value : '';
  if (!lockCfg) { locked = false; route(); return; }
  if (Date.now() < (lockCfg.until || 0)) { say(`輸入錯誤太多次，請 ${Math.ceil((lockCfg.until - Date.now()) / 1000)} 秒後再試。`); return; }
  if (!pin) { say('請輸入 PIN 或密碼。'); return; }
  let ok = false;
  try { ok = hasCrypto && await checkPin(pin); } catch (e) { ok = false; }
  if (ok) {
    lockCfg.fails = 0;
    lockCfg.until = 0;
    writeJSON(LS_LOCK, lockCfg);
    locked = false;
    route();
    return;
  }
  lockCfg.fails = (lockCfg.fails || 0) + 1;
  if (lockCfg.fails % 5 === 0) lockCfg.until = Date.now() + Math.min(30000 * 2 ** (lockCfg.fails / 5 - 1), 900000);
  writeJSON(LS_LOCK, lockCfg);
  say(Date.now() < lockCfg.until ? '輸入錯誤太多次，請稍後再試。' : 'PIN 或密碼不正確。');
  if ($('#pin')) { $('#pin').value = ''; $('#pin').focus(); }
}

/* ============ 求助 ============ */
function viewHelp() {
  render(
    `<div class="crumb"><a href="#/">回首頁</a></div>
    <h1>如果你現在很難受</h1>
    <p>${esc(HELP_TEXT)}</p>
    <p class="sub">這個工具是用來想事情的，不是心理治療或醫療。如果只是想換個角度想想，<a href="#/">回到首頁</a>就可以。</p>`,
    { title: '求助', nav: '' }
  );
}

/* ============ 關於 ============ */
function viewAbout() {
  render(
    `<div class="crumb"><a href="#/">回首頁</a></div>
    <h1>關於思考鏡頭</h1>
    <p>思考鏡頭像一顆維他命，不是處方。它不給答案，只借哲學家的提問，讓你看看別人的觀點、釐清自己的問題，最後由你自己決定。</p>
    <h2>安裝到手機</h2>
    <ul>
      <li>iPhone：用 Safari 開啟，點「分享」，選「加入主畫面」。</li>
      <li>Android：用 Chrome 開啟，從選單選「安裝應用程式」或「加到主畫面」。</li>
      <li>Mac：直接用瀏覽器開啟即可；部分瀏覽器也提供「加入 Dock」或「安裝」。</li>
    </ul>
    <h2>使用提醒</h2>
    <ul>
      <li>${esc(pack.meta.notice)}</li>
      <li>每面鏡頭都有盲點與不適用的情況，請一起讀。</li>
      <li>這是用來想事情的工具，不是心理治療或醫療。</li>
      <li>${esc(HELP_TEXT)}</li>
    </ul>
    <h2>版本</h2>
    <p class="sub">內容包 ${esc(pack.meta.version)}。設計規則：${esc((pack.meta.design_rules || []).join('；'))}。</p>`,
    { title: '關於', nav: '' }
  );
}

/* ============ 事件 ============ */
async function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'start') {
    const problem = ($('#problem').value || '').trim();
    const ids = $$('input[name="lens"]:checked').map((i) => i.value);
    if (!problem) { toast('先用一句話寫下卡住的事'); $('#problem').focus(); return; }
    if (!ids.length) { toast('至少選一面鏡頭'); return; }
    const s = createSession(el.dataset.type, problem, ids);
    location.hash = `#/s/${s.id}`;
  } else if (act === 'reshuffle') {
    const type = typeById(el.dataset.type);
    ui.rec = recommend(type.id, ui.rec && ui.rec.key);
    $('#recBox').innerHTML = recBoxHTML(type, ui.rec);
    paint();
  } else if (act === 'tab') {
    ui.activeLens[ui.sessionId] = el.dataset.id;
    const s = byId(ui.sessionId);
    $('#panel').innerHTML = lensCardHTML(lensById(el.dataset.id), s);
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.id === el.dataset.id)));
    paint();
    $$('textarea', $('#panel')).forEach(autosize);
  } else if (act === 'add-lens') {
    const s = byId(ui.sessionId);
    const id = $('#addLens').value;
    if (s && id && !s.lenses_used.includes(id)) {
      s.lenses_used.push(id);
      ui.activeLens[s.id] = id;
      touch(s);
      flushSave();
      viewSession(s.id);
    }
  } else if (act === 'delete') {
    const s = byId(ui.sessionId);
    if (!s) return;
    if (!confirm('刪除這則紀錄？\n10 秒內可以復原。已匯出的備份檔不會一起刪除。')) return;
    flushSave();
    deleteSessions([s.id]);
    location.hash = '#/history';
  } else if (act === 'manage-on') { ui.manage = true; ui.picked = new Set(); viewHistory(); }
  else if (act === 'manage-off') { ui.manage = false; ui.picked = new Set(); viewHistory(); }
  else if (act === 'pick-all') { ui.picked = new Set(visible().map((s) => s.id)); viewHistory(); }
  else if (act === 'delete-picked') {
    const ids = [...ui.picked];
    if (!ids.length) return;
    if (!confirm(`刪除 ${ids.length} 則紀錄？\n10 秒內可以復原。已匯出的備份檔不會一起刪除。`)) return;
    deleteSessions(ids);
    ui.picked = new Set();
    viewHistory();
  } else if (act === 'storm-flip' && S) {
    S.cards = stormPickCards();
    const thought = ($('#thought') ? $('#thought').value : '').trim();
    if (S.id || thought) {
      const s = ensureStormSession();
      if (thought && !s.problem) s.problem = thought;
      s.updated_at = nowISO();
      persistSessions();
    }
    renderStorm(S.id ? byId(S.id) : null);
  } else if (act === 'storm-swap' && S) {
    const i = Number(el.dataset.i);
    const cur = S.cards[i];
    if (!cur) return;
    const used = new Set(S.cards.map((c) => c.lens));
    const free = quickPool().filter((id) => !used.has(id));
    const lens = free.length ? free[Math.floor(Math.random() * free.length)] : cur.lens;
    S.cards[i] = { lens, question_index: pickQuestion(lens, lens === cur.lens ? cur.question_index : undefined) };
    if (S.id) { const s = ensureStormSession(); s.updated_at = nowISO(); persistSessions(); }
    renderStorm(S.id ? byId(S.id) : null);
  } else if (act === 'chat-next' && C) { C.i++; renderChat(); }
  else if (act === 'chat-stop' && C) { C.ended = true; renderChat(); }
  else if (act === 'chat-restart') startChat();
  else if (act === 'dose-more' && D) doseMore();
  else if (act === 'import-decrypt') decryptImport();
  else if (act === 'import-cancel') { ui.pendingEnc = null; viewBackup(); }
  else if (act === 'lock-now') { if (lockCfg) { flushSave(); locked = true; route(); } }
  else if (act === 'unlock') tryUnlock();
  else if (act === 'lock-on') {
    const a = $('#lockNew').value;
    const b = $('#lockNew2').value;
    if (a.length < 4) { toast('PIN 或密碼至少 4 個字元'); return; }
    if (a !== b) { toast('兩次輸入不一樣'); return; }
    await enableLock(a, $('#lockTimeout').value);
    toast('App 鎖已開啟');
    viewBackup();
  } else if (act === 'lock-off') {
    const cur = $('#lockCur').value;
    let ok = false;
    try { ok = !!cur && await checkPin(cur); } catch (e) { ok = false; }
    if (!ok) { toast('PIN 或密碼不正確'); return; }
    disableLock();
    toast('已關閉 App 鎖');
    viewBackup();
  } else if (act === 'forgot-pin') {
    const v = prompt('忘記 PIN 時，唯一的辦法是清除這台裝置的所有紀錄並解除鎖定，再用備份檔還原。\n要繼續，請輸入「清除」：');
    if (v === '清除') {
      sessions = [];
      meta = {};
      persistSessions();
      persistMeta();
      disableLock();
      toast('已清除並解除鎖定');
      route();
    }
  } else if (act === 'q-next' && Q) qNext();
  else if (act === 'q-switch' && Q) qSwitch();
  else if (act === 'q-act' && Q) qAct();
  else if (act === 'a-small' && Q) { Q.size = 'small'; renderQuick(); }
  else if (act === 'a-other' && Q) {
    const ids = [...new Set(Q.visits.map((v) => v.lens))];
    Q.actionLens = ids[(ids.indexOf(Q.actionLens) + 1) % ids.length];
    Q.size = 'normal';
    renderQuick();
  } else if (act === 'a-accept' && Q) saveAction();
  else if (act === 'fu') {
    const s = byId(el.dataset.id);
    if (s && s.action && ACT_STATUS[el.dataset.s]) {
      s.action.status = el.dataset.s;
      s.action.checked_at = nowISO();
      s.updated_at = nowISO();
      persistSessions();
      toast('已記下');
      viewHome();
    }
  } else if (act === 'share') shareExport();
  else if (act === 'download') downloadExport();
  else if (act === 'copy') copyExport();
  else if (act === 'paste-import') {
    const v = $('#pasteBox').value.trim();
    if (!v) { toast('請先貼上備份文字'); return; }
    handleImport(v);
  } else if (act === 'persist') {
    if (navigator.storage && navigator.storage.persist) {
      const ok = await navigator.storage.persist();
      toast(ok ? '已啟用持久儲存' : '瀏覽器沒有同意。安裝到主畫面後通常比較容易通過。');
      viewBackup();
    } else toast('這個瀏覽器不支援持久儲存');
  } else if (act === 'clear-all') {
    const v = prompt('這會清除這台裝置上的所有紀錄，無法復原。請先確認已匯出備份。\n要繼續，請輸入「清除」：');
    if (v === '清除') {
      sessions = [];
      meta = {};
      persistSessions();
      persistMeta();
      toast('已清除');
      viewBackup();
    }
  }
}

function onChange(e) {
  const el = e.target;
  if (el.id === 'importFile') {
    const f = el.files && el.files[0];
    if (!f) return;
    f.text().then(handleImport).catch(() => toast('讀取檔案失敗'));
    el.value = '';
  } else if (el.id === 'encOn') {
    meta.enc = el.checked;
    persistMeta();
    const box = $('#encBox');
    if (box) box.hidden = !el.checked;
  } else if (el.id === 'coverOn') {
    meta.cover = el.checked;
    persistMeta();
  } else if (el.id === 'lockTimeout' && lockCfg) {
    lockCfg.timeout = el.value;
    writeJSON(LS_LOCK, lockCfg);
    toast('已更新自動鎖定');
  } else if (el.id === 'encPass2') prepareQuiet();
}

/* ============ 啟動 ============ */
function showError(msg) {
  render(`<h1>載入失敗</h1><p>${esc(msg)}</p><div class="actions"><button class="btn primary" id="retry">重試</button></div>`);
  $('#retry').addEventListener('click', () => location.reload());
}

async function init() {
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('toggle', (e) => { if (e.target.tagName === 'DETAILS') $$('textarea', e.target).forEach(autosize); }, true);
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      flushSave();
      cover(true);
    } else {
      cover(false);
      if (lockCfg && !locked && hiddenAt && lockCfg.timeout !== 'never' && Date.now() - hiddenAt >= Number(lockCfg.timeout) * 1000) {
        locked = true;
        route();
      }
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target && e.target.id === 'pin') tryUnlock(); });
  window.addEventListener('storage', (e) => {
    if (e.key === LS_SESSIONS) sessions = readJSON(LS_SESSIONS, []);
    if (e.key === LS_META) meta = readJSON(LS_META, {});
  });
  try {
    const res = await fetch('./data/philosophers.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pack = await res.json();
    if (!pack || !Array.isArray(pack.lenses) || !Array.isArray(pack.stuck_types)) throw new Error('內容包格式不正確');
    pack.collision_pairs = pack.collision_pairs || [];
  } catch (err) {
    showError(`無法讀取內容包(${err.message})。請確認網路連線後重試。`);
    return;
  }
  window.addEventListener('hashchange', route);
  route();
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && secure) navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('sw', e));
}

init();
})();
