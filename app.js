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
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
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
const ui = { sessionId: null, activeLens: {}, rec: null, msg: '' };

const persistSessions = () => writeJSON(LS_SESSIONS, sessions);
const persistMeta = () => writeJSON(LS_META, meta);
const visible = () => sessions.filter((s) => !s.deleted_at);
const byId = (id) => sessions.find((s) => s.id === id && !s.deleted_at);
const lensById = (id) => pack.lenses.find((l) => l.id === id);
const typeById = (id) => pack.stuck_types.find((t) => t.id === id);

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
function statusOf(s) {
  if (!hasConclusion(s)) return { text: '未完成', due: false };
  if (s.review_result) return { text: '已回顧', due: false };
  if (isDue(s)) return { text: '該回顧了', due: true };
  return { text: s.review_at ? `${fmtYmd(s.review_at)} 回顧` : '已完成', due: false };
}
const dueList = () => visible().filter(isDue);

/* ============ 畫面骨架 ============ */
function navHTML(active) {
  const dueN = dueList().length;
  const items = [
    ['', '開始', 'home'],
    ['history', '紀錄', 'history'],
    ['library', '鏡頭', 'library'],
    ['backup', '備份', 'backup']
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
  const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b] = parts;
  window.scrollTo(0, 0);
  if (!a) return viewHome();
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
function sessionRow(s) {
  const st = statusOf(s);
  const names = s.lenses_used.map((id) => lensById(id)?.name).filter(Boolean).join('、');
  const type = typeById(s.stuck_type)?.label || '';
  return `<a class="row" href="#/s/${esc(s.id)}">
    <span class="clamp">${esc(s.problem || '（還沒寫下問題）')}</span>
    <span class="meta"><span>${esc(fmtDate(s.updated_at))}</span>${type ? `<span>${esc(type)}</span>` : ''}${names ? `<span>${esc(names)}</span>` : ''}<span class="badge${st.due ? ' due' : ''}">${esc(st.text)}</span></span>
  </a>`;
}

function viewHome() {
  const due = dueList();
  const drafts = visible().filter((s) => !hasConclusion(s)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 3);
  const dueBlock = due.length
    ? `<section class="notice"><h3>有 ${due.length} 則紀錄到了回顧時間</h3>${due.slice(0, 3).map(sessionRow).join('')}</section>`
    : '';
  const draftBlock = drafts.length
    ? `<h3>還沒寫完的思考</h3><div class="rows">${drafts.map(sessionRow).join('')}</div>`
    : '';
  render(
    `<h1>你卡在哪裡？</h1>
    <p class="sub">選一個最接近的。我會配兩面立場不同的鏡頭，幫你換個角度看。</p>
    ${dueBlock}
    <div class="rows">${pack.stuck_types
      .map((t) => `<a class="row" href="#/new/${esc(t.id)}"><span class="t">${esc(t.label)}</span><span class="h">${esc(t.hint)}</span></a>`)
      .join('')}</div>
    ${draftBlock}
    <p class="small sub"><a href="#/about">關於與使用提醒</a></p>`,
    { nav: 'home' }
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
    `<div class="crumb"><a href="#/">回首頁</a></div>
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
    id: uid(), created_at: t, updated_at: t, problem, stuck_type: typeId,
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
    <label class="field" for="problem">卡住的事</label>
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
  const isRadio = t.getAttribute('name') === 'confidence' || t.getAttribute('name') === 'verdict';
  const f = t.dataset.f;
  if (!f && !isRadio) return;
  const s = byId(ui.sessionId);
  if (!s) return;
  if (t.tagName === 'TEXTAREA') autosize(t);
  s.conclusion = s.conclusion || { judgment: '', next_step: '', confidence: null };
  if (isRadio) {
    if (t.name === 'confidence') s.conclusion.confidence = Number(t.value);
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

/* ============ 紀錄列表 ============ */
function viewHistory() {
  const list = visible().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  render(
    `<h1>紀錄</h1>
    ${list.length
      ? `<p class="sub">共 ${list.length} 則，只存在這台裝置。</p><div class="rows">${list.map(sessionRow).join('')}</div>`
      : `<p class="sub">還沒有紀錄。從<a href="#/">首頁</a>選一個卡住的類型開始。</p>`}`,
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
function exportFileName() {
  const d = new Date();
  return `think-lenses-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}
function markExported() {
  meta.last_export = nowISO();
  persistMeta();
  const el = $('#lastExport');
  if (el) el.textContent = fmtDateTime(meta.last_export);
}
function exportText() { return JSON.stringify(buildExport(), null, 2); }

async function shareExport() {
  flushSave();
  const file = new File([exportText()], exportFileName(), { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '思考鏡頭備份' });
      markExported();
    } catch (e) {
      if (e.name !== 'AbortError') toast('無法開啟分享，請改用「下載備份檔」');
    }
  } else toast('這個瀏覽器不支援分享檔案，請改用「下載備份檔」');
}
function downloadExport() {
  flushSave();
  const blob = new Blob([exportText()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  markExported();
}
async function copyExport() {
  flushSave();
  try {
    await navigator.clipboard.writeText(exportText());
    markExported();
    toast('已複製備份文字');
  } catch (e) { toast('無法複製，請改用下載或分享'); }
}

const str = (v, d = '') => (typeof v === 'string' ? v : d);
function validSession(x) {
  return x && typeof x === 'object' && typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 100
    && typeof x.updated_at === 'string' && !isNaN(Date.parse(x.updated_at))
    && typeof x.created_at === 'string' && !isNaN(Date.parse(x.created_at));
}
function normalize(x) {
  if (x.deleted_at) return { id: x.id, created_at: x.created_at, updated_at: x.updated_at, deleted_at: str(x.deleted_at) };
  const c = x.conclusion && typeof x.conclusion === 'object' ? x.conclusion : {};
  const conf = Number(c.confidence);
  return {
    ...x,
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
  const r = importData(text);
  ui.msg = r.error
    ? `匯入失敗：${r.error}`
    : `匯入完成：新增 ${r.added} 則、更新 ${r.updated} 則、沒有變動 ${r.skipped} 則${r.invalid ? `、略過無效資料 ${r.invalid} 筆` : ''}。`;
  toast(ui.msg);
  viewBackup();
}

function viewBackup() {
  const all = visible();
  const done = all.filter(hasConclusion).length;
  const stale = all.length > 0 && (!meta.last_export || Date.now() - Date.parse(meta.last_export) > 30 * 864e5);
  const msg = ui.msg ? `<p class="notice" role="status">${esc(ui.msg)}</p>` : '';
  ui.msg = '';
  render(
    `<h1>備份與同步</h1>
    <p class="sub">紀錄只存在這台裝置的瀏覽器裡，沒有上傳到任何地方。要在手機和 Mac 之間帶著走，就用備份檔。</p>
    ${msg}
    <div class="panel"><dl>
      <dt>紀錄</dt><dd>${all.length} 則（已寫結論 ${done} 則）</dd>
      <dt>上次匯出</dt><dd id="lastExport">${meta.last_export ? esc(fmtDateTime(meta.last_export)) : '還沒有'}</dd>
      <dt>持久儲存</dt><dd id="persistState">檢查中…</dd>
    </dl></div>
    ${stale ? '<p>已經一段時間沒有備份了，建議現在匯出一次。</p>' : ''}
    <h2>匯出</h2>
    <div class="actions">
      <button class="btn primary" data-act="share">分享或儲存備份檔</button>
      <button class="btn" data-act="download">下載備份檔</button>
      <button class="btn" data-act="copy">複製備份文字</button>
    </div>
    <h2>匯入</h2>
    <p class="sub">匯入是合併，不會整批覆蓋：同一則紀錄只保留比較新的版本。</p>
    <div class="actions">
      <label class="btn">選擇備份檔<input class="hidden-input" type="file" id="importFile" accept=".json,application/json,text/plain"></label>
    </div>
    <label class="field" for="pasteBox">或貼上備份文字</label>
    <textarea id="pasteBox" placeholder="貼上從另一台裝置複製的備份文字"></textarea>
    <div class="actions"><button class="btn" data-act="paste-import">匯入貼上的文字</button></div>
    <h2>兩台裝置之間</h2>
    <ol>
      <li>在一台裝置按「分享或儲存備份檔」，存到 iCloud 雲碟，或用 AirDrop、訊息傳給自己。</li>
      <li>在另一台按「選擇備份檔」匯入。</li>
      <li>需要反向時，再做一次。因為是合併，兩邊都有新紀錄也不會互相覆蓋。</li>
    </ol>
    <p class="small sub">刪除也會跟著備份傳遞：在一台刪掉的紀錄，匯入到另一台後也會被刪除。</p>
    <h2>儲存空間</h2>
    <p class="sub">瀏覽器在空間不足時，可能清掉網站資料。請求持久儲存可以降低這個風險，但仍然不能取代備份。</p>
    <div class="actions"><button class="btn" data-act="persist">請求持久儲存</button></div>
    <h2>清除</h2>
    <div class="actions"><button class="btn danger" data-act="clear-all">清除這台裝置的所有紀錄</button></div>`,
    { title: '備份', nav: 'backup' }
  );
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((p) => { const el = $('#persistState'); if (el) el.textContent = p ? '已啟用' : '未啟用'; });
  } else { const el = $('#persistState'); if (el) el.textContent = '此瀏覽器不支援'; }
}

/* ============ 關於 ============ */
function viewAbout() {
  render(
    `<div class="crumb"><a href="#/">回首頁</a></div>
    <h1>關於思考鏡頭</h1>
    <p>這是一個幫你把卡住的事想清楚的工具。它不給答案，只借哲學家的提問，讓你換幾個角度看，最後由你自己寫下判斷。</p>
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
      <li>如果你有傷害自己的念頭，或覺得撐不下去，請現在聯絡身邊信任的人或專業協助。在台灣可撥安心專線 1925，緊急時撥 119。</li>
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
    if (!confirm('刪除這則紀錄？刪除也會在匯入備份時傳遞到另一台裝置，無法復原。')) return;
    const i = sessions.indexOf(s);
    const t = nowISO();
    sessions[i] = { id: s.id, created_at: s.created_at, updated_at: t, deleted_at: t };
    flushSave();
    persistSessions();
    toast('已刪除');
    location.hash = '#/history';
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
  if (e.target.id === 'importFile') {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    f.text().then(handleImport).catch(() => toast('讀取檔案失敗'));
    e.target.value = '';
  }
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
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
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
