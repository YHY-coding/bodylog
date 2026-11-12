// からだログ(仮称) 第1版。すべて端末内で完結。外部通信なし(CSPでも禁止)。
(function () {
  'use strict';
  const calc = BL.calc, csv = BL.csv, db = BL.db;
  const VERSION = '1.0.0';

  // ---------- 小道具 ----------
  function h(tag, props) {
    const el = document.createElement(tag);
    const p = props || {};
    Object.keys(p).forEach((k) => {
      const v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (k === 'style') Object.assign(el.style, v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (let i = 2; i < arguments.length; i++) {
      [].concat(arguments[i]).flat(Infinity).forEach((c) => {
        if (c == null || c === false) return;
        el.append(c.nodeType ? c : document.createTextNode(String(c)));
      });
    }
    return el;
  }
  const $ = (s, r) => (r || document).querySelector(s);
  const today = () => calc.keyOf(new Date());
  const f1 = (v) => (typeof v === 'number' ? (Math.round(v * 10 + (v < 0 ? -1e-9 : 1e-9)) / 10).toFixed(1) : '—'); // 四捨五入(ちょうど半分は切り上げ)
  const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1);
  const lab = (d, y) => calc.labelOf(d, y);
  const nowTime = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // ---------- 状態 ----------
  const S = { records: [], days: {}, meals: [], health: [], progress: [], settings: {} };
  const UI = { tab: 'home', logMode: 'list', calMonth: today().slice(0, 7), gMetric: 'weight', gRange: '30', listLimit: 60 };
  const pages = [];

  async function load() {
    const [r, d, m, hl, pr, st] = await Promise.all(['records', 'days', 'meals', 'health', 'progress', 'settings'].map((s) => db.all(s)));
    S.records = r; S.meals = m; S.health = hl; S.progress = pr;
    S.days = {}; d.forEach((x) => { S.days[x.date] = x; });
    S.settings = {}; st.forEach((x) => { S.settings[x.key] = x.value; });
  }
  async function setSetting(k, v) {
    if (v === null || v === undefined) delete S.settings[k]; else S.settings[k] = v;
    await db.put('settings', { key: k, value: v === undefined ? null : v });
  }
  async function saveItem(store, arr, item) {
    if (!item.createdAt) item.createdAt = Date.now();
    const key = await db.put(store, item);
    if (item.id === undefined) item.id = key;
    const i = arr.findIndex((x) => x.id === item.id);
    if (i >= 0) arr[i] = item; else arr.push(item);
    return item;
  }
  async function removeItem(store, arr, id) {
    await db.del(store, id);
    const i = arr.findIndex((x) => x.id === id); if (i >= 0) arr.splice(i, 1);
  }
  const saveRecord = (r) => saveItem('records', S.records, r);
  async function saveDay(day) { await db.put('days', day); S.days[day.date] = day; }
  function dayOf(date) { return S.days[date] || { date, exercise: {}, pain: [], memo: '' }; }
  function recordsOn(date) { return S.records.filter((r) => r.date === date).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }

  // ---------- トースト・確認・ページ ----------
  let toastTimer = null;
  function toast(msg, undo) {
    const t = $('#toast'); t.replaceChildren(h('span', { class: 'grow', text: msg }));
    if (undo) t.append(h('button', { text: '元に戻す', onclick: () => { t.hidden = true; undo(); } }));
    t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 6000 : 2600);
  }
  function confirmBox(message, okLabel, danger, detail) {
    return new Promise((resolve) => {
      const done = (v) => { m.remove(); resolve(v); };
      const m = h('div', { class: 'overlay modal', role: 'alertdialog', 'aria-modal': 'true' },
        h('div', { class: 'box' },
          h('p', { text: message, style: { margin: '0 0 8px', fontWeight: '700' } }),
          detail ? h('p', { class: 'sub', text: detail, style: { margin: '0 0 14px', whiteSpace: 'pre-line' } }) : null,
          h('div', { class: 'row', style: { gap: '10px' } },
            h('button', { class: 'btn grow', text: 'やめる', onclick: () => done(false) }),
            h('button', { class: 'btn grow ' + (danger ? 'danger' : 'primary'), text: okLabel || 'OK', onclick: () => done(true) }))));
      $('#overlays').append(m);
    });
  }
  // 全画面ページ。render(body, page) を最初と refresh のたびに呼ぶ
  function openPage(title, render, opts) {
    opts = opts || {};
    const body = h('div');
    const page = { el: null, refresh: () => { if (opts.static) return; const y = page.el.scrollTop; body.replaceChildren(); render(body, page); page.el.scrollTop = y; }, close: () => { page.el.remove(); const i = pages.indexOf(page); if (i >= 0) pages.splice(i, 1); if (opts.onClose) opts.onClose(); } };
    page.el = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'in' },
        h('div', { class: 'ohead' }, h('button', { class: 'btn small ghost', text: '‹ 戻る', onclick: page.close }), h('h1', { text: title })),
        body));
    pages.push(page); $('#overlays').append(page.el);
    render(body, page);
    return page;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pages.length) pages[pages.length - 1].close(); });
  function refreshAll() { renderView(); pages.forEach((p) => p.refresh()); }

  // ---------- 入力の部品 ----------
  const FIELDS = [
    { k: 'weight', label: '体重', unit: 'kg', min: 20, max: 300, dec: 1 },
    { k: 'fat', label: '体脂肪率', unit: '%', min: 1, max: 70, dec: 1 },
    { k: 'muscle', label: '骨格筋率', unit: '%', min: 5, max: 90, dec: 1 },
    { k: 'water', label: '体水分', unit: '%', min: 10, max: 90, dec: 1 },
    { k: 'bone', label: '骨量', unit: 'kg', min: 0.3, max: 15, dec: 1 },
    { k: 'bmr', label: '基礎代謝', unit: 'kcal', min: 300, max: 5000, dec: 0 },
    { k: 'bmi', label: 'BMI', unit: '', min: 8, max: 80, dec: 1 },
  ];
  const TIMINGS = ['起床後', '朝食後', '昼', '夜'];
  function parseNum(s) { // '' -> null / 読めない -> undefined
    s = String(s == null ? '' : s).trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[．。]/g, '.').replace(/[，,]/g, '.');
    if (s === '') return null;
    const v = Number(s); return isFinite(v) ? v : undefined;
  }
  function lastValue(k, upTo) {
    let best = null;
    S.records.forEach((r) => {
      if (typeof r[k] !== 'number' || r.date > upTo) return;
      if (!best || r.date > best.date || (r.date === best.date && (r.createdAt || 0) > (best.createdAt || 0))) best = r;
    });
    return best;
  }
  function chipGroup(options, current, onPick) {
    const box = h('div', { class: 'chips', role: 'group' });
    const draw = (cur) => { box.replaceChildren(...options.map((o) => h('button', { class: 'chip', 'aria-pressed': String(cur === o), text: o, onclick: () => { cur = cur === o ? '' : o; onPick(cur); draw(cur); } }))); };
    draw(current); return box;
  }

  // ---------- 記録入力(1項目ずつ) ----------
  function openEntry(opts) {
    const st = { date: (opts && opts.date) || today(), timing: '', vals: {}, note: '', reference: false, step: 1 };
    let page;
    const hasVal = () => FIELDS.some((f) => typeof st.vals[f.k] === 'number');
    const body = h('div', { class: 'step' });
    page = openPage('記録する', () => {}, { static: true });
    page.el.querySelector('.in').append(body);
    page.el.querySelector('.ohead .btn').textContent = '‹ やめる';

    function header() {
      return h('button', { class: 'btn small ghost', style: { marginBottom: '6px' }, 'aria-label': '日付と時間帯を変える', onclick: () => { st.step = 0; draw(); } },
        (st.date === today() ? '今日 ' : '') + lab(st.date) + (st.timing ? ' · ' + st.timing : '') + '  ✎');
    }
    function progress() { return h('div', { class: 'prog', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5, 6, 7, 8].map((i) => h('i', { class: i <= st.step ? 'on' : '' }))); }

    async function save() {
      const rec = { date: st.date, timing: st.timing, note: st.note.trim(), flags: {}, source: 'manual' };
      FIELDS.forEach((f) => { rec[f.k] = typeof st.vals[f.k] === 'number' ? st.vals[f.k] : null; });
      if (st.reference) rec.flags.reference = true;
      await saveRecord(rec);
      page.close(); refreshAll(); toast('保存しました'); askPersist();
    }
    function draw() {
      body.replaceChildren();
      if (st.step === 0) return drawWhen();
      if (st.step >= 1 && st.step <= 7) return drawField(FIELDS[st.step - 1]);
      return drawFinal();
    }
    function drawWhen() {
      const di = h('input', { type: 'date', value: st.date, 'aria-label': '日付' });
      body.append(h('h2', { text: 'いつの記録?' }), h('label', { class: 'f', text: '日付' }), di,
        h('label', { class: 'f', text: '測ったタイミング(なくてもかまいません)' }),
        chipGroup(TIMINGS, TIMINGS.includes(st.timing) ? st.timing : '', (v) => { st.timing = v; other.value = ''; }));
      const other = h('input', { type: 'text', placeholder: 'ほかのタイミング(例: ジム後)', value: TIMINGS.includes(st.timing) ? '' : st.timing, style: { marginTop: '10px' }, maxlength: '60' });
      other.addEventListener('input', () => { st.timing = other.value; });
      body.append(other, h('div', { class: 'gap' }),
        h('button', { class: 'btn primary big', text: 'この日時で進む', onclick: () => { if (calc.isRealKey(di.value)) st.date = di.value; st.step = 1; draw(); } }));
    }
    function drawField(f) {
      const prev = lastValue(f.k, st.date);
      const inp = h('input', { class: 'num', type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': f.label, value: typeof st.vals[f.k] === 'number' ? String(st.vals[f.k]) : '' });
      const hint = h('div', { class: 'hint' });
      const upd = () => {
        const v = parseNum(inp.value);
        if (v === undefined) hint.textContent = '数字で入れてください(例 91.4)';
        else if (v !== null && (v < f.min || v > f.max)) hint.textContent = 'この数字で合っていますか?(そのまま進めます)';
        else hint.textContent = prev ? '前回 ' + prev[f.k] + ' ' + f.unit + '(' + lab(prev.date) + ')' : '体組成計の画面の数字を入れます';
      };
      const commit = () => { const v = parseNum(inp.value); if (v === undefined) return false; if (v === null) delete st.vals[f.k]; else st.vals[f.k] = v; return true; };
      const go = (d) => { if (!commit()) { upd(); return; } st.step += d; draw(); };
      inp.addEventListener('input', upd);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(1); } });
      body.append(header(), progress(), h('h2', { text: f.label, style: { textAlign: 'center', fontSize: '18px' } }), inp, h('div', { class: 'unit', text: f.unit || ' ' }), hint, h('div', { class: 'gap' }),
        h('button', { class: 'btn primary big', text: st.step === 7 ? '次へ(メモ)' : '次へ', onclick: () => go(1) }),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'btn grow', text: '戻る', disabled: st.step === 1, onclick: () => go(-1) }),
          h('button', { class: 'btn grow', text: 'とばす', onclick: () => { delete st.vals[f.k]; inp.value = ''; st.step += 1; draw(); } })),
        h('button', { class: 'btn ghost', style: { width: '100%', marginTop: '6px' }, text: 'ここで保存する', onclick: () => { if (!commit()) { upd(); return; } if (!hasVal()) { hint.textContent = '数字が1つもありません。「とばす」で進めます'; return; } st.step = 8; draw(); } }));
      upd();
      setTimeout(() => inp.focus(), 30);
    }
    function drawFinal() {
      const note = h('textarea', { 'aria-label': '備考', placeholder: '例: 前夜に飲酒、フットサル後、など', maxlength: '500', value: st.note });
      note.addEventListener('input', () => { st.note = note.value; });
      const ref = h('input', { type: 'checkbox', checked: st.reference, 'aria-label': '参考値にする' });
      ref.addEventListener('change', () => { st.reference = ref.checked; });
      const sum = FIELDS.filter((f) => typeof st.vals[f.k] === 'number').map((f) => f.label + ' ' + st.vals[f.k] + f.unit).join(' / ');
      body.append(header(), progress(), h('h2', { text: 'メモと保存' }), h('p', { class: 'sub', text: sum || '(数字なし)' }),
        h('label', { class: 'f', text: '備考(出来事など)' }), note,
        h('label', { class: 'sw' }, ref, h('span', null, '参考値にする', h('span', { class: 'sub small', style: { display: 'block' }, text: 'いつもと条件が違う日の印です。平均やグラフの線には入らず、点だけ薄く残ります。' }))),
        h('div', { class: 'gap' }),
        h('button', { class: 'btn primary big', text: '保存する', onclick: save }),
        h('button', { class: 'btn', style: { width: '100%', marginTop: '10px' }, text: '戻る', onclick: () => { st.step = 7; draw(); } }));
    }
    draw();
  }

  // ---------- 記録の編集(全項目を1画面で) ----------
  function openRecordEditor(rec) {
    const isNew = !rec.id;
    const page = openPage(isNew ? '記録を追加' : '記録を直す', (body) => {
      const inputs = {};
      const date = h('input', { type: 'date', value: rec.date, 'aria-label': '日付' });
      const timing = h('input', { type: 'text', value: rec.timing || '', maxlength: '60', 'aria-label': 'タイミング' });
      const note = h('textarea', { maxlength: '500', value: rec.note || '', 'aria-label': '備考' });
      body.append(h('label', { class: 'f', text: '日付' }), date, h('label', { class: 'f', text: 'タイミング' }), timing);
      FIELDS.forEach((f) => {
        inputs[f.k] = h('input', { type: 'text', inputmode: 'decimal', value: typeof rec[f.k] === 'number' ? String(rec[f.k]) : '', 'aria-label': f.label + (f.unit ? '(' + f.unit + ')' : '') });
        body.append(h('label', { class: 'f', text: f.label + (f.unit ? '(' + f.unit + ')' : '') }), inputs[f.k]);
      });
      body.append(h('label', { class: 'f', text: '備考' }), note);
      const flags = Object.assign({}, rec.flags);
      const sw = (key, text, sub) => { const c = h('input', { type: 'checkbox', checked: !!flags[key] }); c.addEventListener('change', () => { flags[key] = c.checked; }); return h('label', { class: 'sw' }, c, h('span', null, text, sub ? h('span', { class: 'sub small', style: { display: 'block' }, text: sub }) : null)); };
      body.append(sw('reference', '参考値', '平均・グラフの線には入りません'), sw('none', '測定なし', '数字がない日の印です(平均には入りません)'), sw('estimated', '日付は推定', '日付がはっきりしない記録の印です(平均には入ります)'));
      const msg = h('p', { class: 'sub', role: 'status' });
      body.append(msg, h('button', { class: 'btn primary big', text: '保存する', onclick: async () => {
        if (!calc.isRealKey(date.value)) { msg.textContent = '日付を選んでください。'; return; }
        const next = Object.assign({}, rec, { date: date.value, timing: timing.value.trim(), note: note.value.trim(), flags: {} });
        for (const f of FIELDS) { const v = parseNum(inputs[f.k].value); if (v === undefined) { msg.textContent = f.label + 'が数字として読めません。'; return; } next[f.k] = v; }
        ['reference', 'none', 'estimated'].forEach((k) => { if (flags[k]) next.flags[k] = true; });
        await saveRecord(next); page.close(); refreshAll(); toast('保存しました');
      } }));
      if (!isNew) body.append(h('button', { class: 'btn danger', style: { width: '100%', marginTop: '10px' }, text: 'この記録を削除', onclick: async () => {
        if (await confirmBox('この記録を削除しますか?', '削除する', true, lab(rec.date) + ' ' + (typeof rec.weight === 'number' ? rec.weight + 'kg' : ''))) { const copy = Object.assign({}, rec); await removeItem('records', S.records, rec.id); page.close(); refreshAll(); toast('削除しました', async () => { delete copy.id; await saveRecord(copy); refreshAll(); }); }
      } }));
    }, { static: true });
  }

  // ---------- 1日の詳細 ----------
  const EX = [['run', 'ラン3km', '🏃'], ['futsal', 'フットサル', '⚽'], ['strength', '筋トレ', '🏋'], ['rest', '休養', '💤'], ['other', 'その他の運動', '✔']];
  const PAIN_PLACES = ['足首', 'ふくらはぎ', 'ひざ', '腰', '肩', 'その他'];
  function exerciseChips(date, afterChange) {
    const box = h('div', { class: 'chips', role: 'group', 'aria-label': '運動チェック' });
    const draw = () => {
      const ex = dayOf(date).exercise || {};
      box.replaceChildren(...EX.map((e) => h('button', { class: 'chip', 'aria-pressed': String(!!ex[e[0]]), text: e[2] + ' ' + e[1], onclick: async () => {
        const d = dayOf(date); d.exercise = Object.assign({}, d.exercise); d.exercise[e[0]] = !d.exercise[e[0]]; if (!d.pain) d.pain = []; await saveDay(d); draw(); if (afterChange) afterChange();
      } })));
    };
    draw(); return box;
  }
  function openDay(date) {
    openPage(lab(date, true) + (date === today() ? ' 今日' : ''), (body, page) => {
      const recs = recordsOn(date);
      body.append(h('div', { class: 'card' }, h('h2', { text: '体の記録' }),
        recs.length ? h('div', { class: 'list' }, recs.map((r) => recordRow(r, true))) : h('p', { class: 'sub', text: 'この日の記録はありません。' }),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'btn primary grow', text: '記録を追加', onclick: () => openEntry({ date }) }),
          h('button', { class: 'btn grow', text: '測定なし', onclick: async () => { await saveRecord({ date, timing: '', note: '', flags: { none: true }, source: 'manual', weight: null, fat: null, muscle: null, water: null, bone: null, bmr: null, bmi: null }); refreshAll(); } }))));
      body.append(h('div', { class: 'card' }, h('h2', { text: '運動チェック' }), exerciseChips(date, () => renderView())));
      const day = dayOf(date);
      const painBox = h('div');
      const memo = h('textarea', { 'aria-label': '体調メモ', placeholder: '体調・気づいたこと', maxlength: '1000', value: day.memo || '' });
      const persist = async () => { const d = dayOf(date); d.memo = memo.value; d.pain = pain; if (!d.exercise) d.exercise = {}; await saveDay(d); renderView(); };
      let pain = (day.pain || []).map((p) => ({ place: p.place, level: p.level }));
      const drawPain = () => {
        painBox.replaceChildren(
          ...pain.map((p, i) => {
            const out = h('b', { text: String(p.level), class: 'mono' });
            const rg = h('input', { type: 'range', class: 'range', min: '0', max: '10', step: '1', value: String(p.level), 'aria-label': p.place + 'の痛み(0〜10)' });
            rg.addEventListener('input', () => { p.level = Number(rg.value); out.textContent = rg.value; });
            rg.addEventListener('change', persist);
            return h('div', { style: { marginBottom: '10px' } }, h('div', { class: 'row between' }, h('span', { text: p.place }), h('span', null, '強さ ', out, ' / 10', h('button', { class: 'btn small ghost', text: '消す', 'aria-label': p.place + 'を消す', onclick: () => { pain.splice(i, 1); drawPain(); persist(); } }))), rg);
          }),
          h('div', { class: 'sub small', text: '場所を選んで追加(強さは0〜10)' }),
          h('div', { class: 'chips', style: { marginTop: '6px' } }, PAIN_PLACES.map((pl) => h('button', { class: 'chip sm', text: '＋ ' + pl, onclick: () => { pain.push({ place: pl, level: 3 }); drawPain(); persist(); } }))));
      };
      drawPain();
      memo.addEventListener('change', persist);
      body.append(h('div', { class: 'card' }, h('h2', { text: '痛みと体調のメモ' }), painBox, h('label', { class: 'f', text: '体調メモ' }), memo));
      const meals = S.meals.filter((m) => m.date === date);
      body.append(h('div', { class: 'card' }, h('h2', { text: '食事' }),
        meals.length ? h('div', { class: 'list' }, meals.sort(mealSort).map(mealRow)) : h('p', { class: 'sub', text: 'この日の食事の記録はありません。' }),
        h('button', { class: 'btn', style: { marginTop: '10px' }, text: '食事を記録', onclick: () => openMealEditor({ date }) })));
    });
  }
  function recordRow(r, inDay) {
    const none = r.flags && r.flags.none;
    const t = today();
    const first = S.records.filter((x) => x.date === r.date).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] === r;
    const ex = (dayOf(r.date).exercise) || {};
    const marks = EX.filter((e) => e[0] !== 'rest' && ex[e[0]]).map((e) => e[2]).join('');
    const pain = (dayOf(r.date).pain || []);
    return h('button', { class: 'item' + (none ? ' faint' : ''), onclick: () => openRecordEditor(r), 'aria-label': lab(r.date) + ' ' + (none ? '測定なし' : f1(r.weight) + 'キログラム') + ' 記録を直す' },
      inDay ? null : h('div', { class: 'd' }, h('span', { text: lab(r.date) }), h('small', { text: r.date.slice(0, 4) })),
      h('div', { class: 'grow' },
        h('div', null, none ? '測定なし' : (r.timing || ''), r.date === t && first ? h('span', { class: 'tag on', text: '本日' }) : null,
          r.flags && r.flags.reference ? h('span', { class: 'tag', text: '参考値' }) : null, r.flags && r.flags.estimated ? h('span', { class: 'tag', text: '日付推定' }) : null),
        h('div', { class: 'sub small', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: [r.note, !inDay && marks ? marks : '', !inDay && pain.length ? '痛み' + pain.map((p) => p.place + p.level).join('・') : ''].filter(Boolean).join('  ') })),
      none ? null : h('div', { style: { textAlign: 'right' } }, h('div', { class: 'v mono' }, typeof r.weight === 'number' ? f1(r.weight) : '—', h('small', { text: typeof r.weight === 'number' ? ' kg' : '' })),
        typeof r.fat === 'number' ? h('div', { class: 'sub small mono', text: '体脂肪 ' + f1(r.fat) + '%' }) : null));
  }

  // ---------- 写真(端末内。縮小して保存) ----------
  const urls = new Map();
  function blobUrl(key, blob) { if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob)); return urls.get(key); }
  async function decode(blob) {
    if (window.createImageBitmap) { try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* 下で別の方法 */ } }
    const u = URL.createObjectURL(blob);
    try { return await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = u; }); } finally { URL.revokeObjectURL(u); }
  }
  async function shrink(bitmap, maxSide, q) {
    const w = bitmap.width, hh = bitmap.height, sc = Math.min(1, maxSide / Math.max(w, hh));
    const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(w * sc)); cv.height = Math.max(1, Math.round(hh * sc));
    cv.getContext('2d').drawImage(bitmap, 0, 0, cv.width, cv.height);
    return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', q));
  }
  async function processPhoto(file) {
    if (file.size > 40 * 1024 * 1024) throw new Error('large');
    const bmp = await decode(file);
    return { full: await shrink(bmp, 1280, 0.8), thumb: await shrink(bmp, 320, 0.7) };
  }
  function thumbImg(photoId, alt) {
    const im = h('img', { alt: alt || '', loading: 'lazy' });
    if (photoId) db.thumb(photoId).then((b) => { if (b) im.src = blobUrl('t' + photoId, b); });
    return im;
  }
  function photoPicker(initialId, onChange) {
    const state = { photoId: initialId || null, pending: null };
    const box = h('div');
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': '写真を選ぶ' });
    const msg = h('p', { class: 'sub small', role: 'status' });
    const draw = () => {
      box.replaceChildren(
        state.pending ? h('img', { src: state.pending.url, alt: '選んだ写真', style: { width: '100%', maxHeight: '260px', objectFit: 'contain', borderRadius: '12px', background: 'var(--chip)' } })
          : state.photoId ? h('div', { style: { maxWidth: '220px' } }, thumbImg(state.photoId, '保存済みの写真')) : null,
        h('button', { class: 'btn', style: { marginTop: '8px' }, text: state.pending || state.photoId ? '写真を選び直す' : '写真を選ぶ・撮る', onclick: () => input.click() }), input, msg);
    };
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0]; if (!f) return;
      msg.textContent = '読み込み中…';
      try { const p = await processPhoto(f); state.pending = { blobs: p, url: URL.createObjectURL(p.thumb) }; msg.textContent = ''; if (onChange) onChange(state); draw(); }
      catch (e) { msg.textContent = '写真を読み込めませんでした。別の写真でお試しください。'; }
    });
    state.commit = async () => { if (!state.pending) return state.photoId; return db.addImage(state.pending.blobs.full, state.pending.blobs.thumb); };
    draw(); state.el = box; return state;
  }

  // ---------- 食事 ----------
  const SLOTS = ['朝', '昼', '夜', '間食'];
  const mealSort = (a, b) => (a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : (a.createdAt || 0) - (b.createdAt || 0);
  function mealRow(m) {
    return h('button', { class: 'item', onclick: () => openMealEditor(m), 'aria-label': lab(m.date) + ' ' + m.slot + ' 食事を直す' },
      h('div', { style: { width: '56px', height: '56px', borderRadius: '10px', overflow: 'hidden', background: 'var(--chip)', flex: 'none' } }, m.photoId ? thumbImg(m.photoId, '食事の写真') : null),
      h('div', { class: 'grow' }, h('div', null, m.slot + (m.time ? ' ' + m.time : '')), h('div', { class: 'sub small', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: m.memo || '' })),
      typeof m.kcal === 'number' ? h('div', { class: 'v mono' }, (m.approx ? '約' : '') + String(m.kcal), h('small', { text: ' kcal' })) : null);
  }
  function openMealEditor(meal) {
    const isNew = !meal.id;
    const page = openPage(isNew ? '食事を記録' : '食事を直す', (body) => {
      const m = Object.assign({ slot: '', time: nowTime(), memo: '', kcal: null, kcalEst: null, nutritionNote: '', visibility: 'private' }, meal);
      if (isNew && !m.slot) { const hr = new Date().getHours(); m.slot = hr < 10 ? '朝' : hr < 15 ? '昼' : hr < 22 ? '夜' : '間食'; }
      const date = h('input', { type: 'date', value: m.date || today(), 'aria-label': '日付' });
      const time = h('input', { type: 'time', value: m.time || '', 'aria-label': '時刻' });
      const memo = h('textarea', { maxlength: '1000', value: m.memo, placeholder: '何を食べたか、量、気づいたこと', 'aria-label': 'メモ' });
      const kcal = h('input', { type: 'text', inputmode: 'numeric', value: typeof m.kcal === 'number' ? String(m.kcal) : '', placeholder: '分かるときだけ(任意)', 'aria-label': 'カロリー(任意)' });
      const protein = h('input', { type: 'text', inputmode: 'decimal', value: typeof m.protein === 'number' ? String(m.protein) : '', placeholder: '分かるときだけ(任意)', 'aria-label': 'たんぱく質(任意)' });
      const approx = h('input', { type: 'checkbox', checked: !!m.approx, 'aria-label': '数字は概算' });
      const picker = photoPicker(m.photoId, () => {});
      const msg = h('p', { class: 'sub', role: 'status' });
      body.append(h('label', { class: 'f', text: '写真' }), picker.el, h('label', { class: 'f', text: '日付' }), date, h('label', { class: 'f', text: '時間帯' }),
        chipGroup(SLOTS, m.slot, (v) => { m.slot = v; }), h('label', { class: 'f', text: '時刻(任意)' }), time,
        h('label', { class: 'f', text: 'メモ' }), memo, h('label', { class: 'f', text: 'カロリー kcal(手入力・任意)' }), kcal, h('label', { class: 'f', text: 'たんぱく質 g(手入力・任意)' }), protein,
        h('label', { class: 'sw' }, approx, h('span', { text: '数字は「約」(概算)' })),
        h('p', { class: 'sub small', text: 'AIによる自動計算は今後の版で検討中です。今は写真とメモの記録だけです。' }), msg,
        h('button', { class: 'btn primary big', text: '保存する', onclick: async () => {
          if (!calc.isRealKey(date.value)) { msg.textContent = '日付を選んでください。'; return; }
          const kv = parseNum(kcal.value); if (kv === undefined || (kv !== null && (kv < 0 || kv > 20000))) { msg.textContent = 'カロリーは数字で入れてください(空欄でもかまいません)。'; return; }
          const pv = parseNum(protein.value); if (pv === undefined || (pv !== null && (pv < 0 || pv > 1000))) { msg.textContent = 'たんぱく質は数字で入れてください(空欄でもかまいません)。'; return; }
          if (!m.slot) m.slot = '間食';
          if (!picker.pending && !m.photoId && !memo.value.trim() && kv === null) { msg.textContent = '写真かメモのどちらかを入れてください。'; return; }
          const oldPhoto = m.photoId; const pid = await picker.commit();
          const next = Object.assign({}, m, { date: date.value, time: time.value, memo: memo.value.trim(), kcal: kv, protein: pv, approx: approx.checked, photoId: pid || null });
          await saveItem('meals', S.meals, next);
          if (oldPhoto && pid !== oldPhoto) { await db.delImage(oldPhoto); }
          page.close(); refreshAll(); toast('保存しました'); askPersist();
        } }));
      if (!isNew) body.append(h('button', { class: 'btn danger', style: { width: '100%', marginTop: '10px' }, text: 'この食事の記録を削除', onclick: async () => {
        if (await confirmBox('この食事の記録を削除しますか?', '削除する', true, '写真も端末から消えます。元に戻せません。')) { if (meal.photoId) await db.delImage(meal.photoId); await removeItem('meals', S.meals, meal.id); page.close(); refreshAll(); }
      } }));
    }, { static: true });
  }
  function viewMeals(c) {
    c.append(h('div', { class: 'row between' }, h('h1', { text: '食事' }), h('button', { class: 'btn primary small', text: '＋ 記録する', onclick: () => openMealEditor({ date: today() }) })));
    if (!S.meals.length) { c.append(h('div', { class: 'card' }, h('p', { text: 'まだ食事の記録はありません。' }), h('p', { class: 'sub', text: '写真を撮って、時間帯とメモを残せます。写真はこの端末の中だけに保存されます。カロリーは分かるときだけ手で入れられます。' }), h('button', { class: 'btn primary', text: '最初の食事を記録', onclick: () => openMealEditor({ date: today() }) }))); return; }
    const g = S.settings;
    if (typeof g.kcalTarget === 'number') {
      c.append(h('div', { class: 'banner' }, h('b', { text: '1日の目安' }), '摂取 ' + g.kcalTarget.toLocaleString('ja-JP') + ' kcal' + (typeof g.kcalMin === 'number' ? '(下限 ' + g.kcalMin.toLocaleString('ja-JP') + ')' : '')
        + (typeof g.proteinTarget === 'number' ? ' / たんぱく質 ' + g.proteinTarget + ' g' : '') + (typeof g.fatMin === 'number' ? ' / 脂質 ' + g.fatMin + (typeof g.fatMax === 'number' ? '〜' + g.fatMax : '') + ' g' : ''),
        h('div', { class: 'sub small', text: 'あくまで目安です。日によってずれても、ふつうの記録です。' })));
    }
    const byDate = {};
    S.meals.forEach((m) => { (byDate[m.date] = byDate[m.date] || []).push(m); });
    Object.keys(S.days).forEach((d) => { if (S.days[d].intake && !byDate[d]) byDate[d] = []; });
    Object.keys(byDate).sort().reverse().slice(0, UI.mealLimit || 30).forEach((d) => {
      const list = byDate[d].sort(mealSort);
      const sum = list.reduce((s, m) => s + (typeof m.kcal === 'number' ? m.kcal : 0), 0), psum = list.reduce((s, m) => s + (typeof m.protein === 'number' ? m.protein : 0), 0);
      const has = list.some((m) => typeof m.kcal === 'number'), hasP = list.some((m) => typeof m.protein === 'number');
      const ap = list.some((m) => m.approx) ? '約 ' : '';
      const tg = typeof g.kcalTarget === 'number' ? '(目安 ' + g.kcalTarget.toLocaleString('ja-JP') + ')' : '', tp = typeof g.proteinTarget === 'number' ? '(目安 ' + g.proteinTarget + ')' : '';
      const it = (S.days[d] || {}).intake;
      c.append(h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', { text: lab(d) + (d === today() ? ' 今日' : ''), style: { margin: 0 } })),
        has || hasP ? h('div', { class: 'sub small mono', style: { margin: '4px 0' }, text: '入力分の合計 ' + (has ? ap + sum.toLocaleString('ja-JP') + ' kcal' + tg : '') + (has && hasP ? ' / ' : '') + (hasP ? 'たんぱく質 ' + ap + psum + ' g' + tp : '') }) : null,
        it ? h('div', { class: 'sub small mono', style: { margin: '4px 0' }, text: '1日の概算(記載値): ' + (it.kcalMin ? '約 ' + it.kcalMin.toLocaleString('ja-JP') + (it.kcalMax && it.kcalMax !== it.kcalMin ? '〜' + it.kcalMax.toLocaleString('ja-JP') : '') + ' kcal' : '') + (it.protein ? ' / たんぱく質 約 ' + it.protein + ' g' : '') }) : null,
        h('div', { class: 'list' }, list.map(mealRow))));
    });
    if (Object.keys(byDate).length > (UI.mealLimit || 30)) c.append(h('button', { class: 'btn', style: { width: '100%' }, text: 'さらに表示', onclick: () => { UI.mealLimit = (UI.mealLimit || 30) + 30; renderView(); } }));
  }

  // ---------- ホーム ----------
  function isStandalone() { return !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)); }
  function dataCount() { return S.records.length + S.meals.length + S.progress.length + S.health.length; }
  function viewHome(c) {
    const T = today();
    const last = S.settings.lastExport;
    if (dataCount() >= 3 && (!last || Date.now() - last > 7 * 864e5) && !UI.hideBackup) {
      c.append(h('div', { class: 'banner', role: 'note' }, h('b', { text: 'バックアップ(書き出し)をおすすめします' }),
        last ? '最後の書き出しは ' + Math.floor((Date.now() - last) / 864e5) + ' 日前です。' : 'まだ書き出していません。', ' iPhoneのSafariは、しばらく使わないと保存データを消すことがあります。',
        h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn small primary', text: '書き出す', onclick: () => openDataPage() }), h('button', { class: 'btn small ghost', text: 'あとで', onclick: () => { UI.hideBackup = true; renderView(); } }))));
    }
    if (!isStandalone() && !S.settings.installHintDismissed) {
      c.append(h('div', { class: 'banner', role: 'note' }, h('b', { text: 'ホーム画面に追加すると安心です' }),
        'iPhoneのSafariで、下の共有ボタン →「ホーム画面に追加」。アプリのように開けて、データも消えにくくなります(消えないという保証はありません)。',
        h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn small ghost', text: '閉じる', onclick: async () => { await setSetting('installHintDismissed', true); renderView(); } }))));
    }
    const ch = calc.challenge(S.settings, S.days, T);
    const chCard = h('div', { class: 'card' });
    if (ch.state === 'none') {
      chCard.append(h('h2', { text: '30日チャレンジ' }), h('p', { class: 'sub', text: '毎日の運動を続ける目標です。開始日から数えます。' }), h('button', { class: 'btn primary', text: 'チャレンジを始める', onclick: () => openChallengeSetup() }));
    } else if (ch.state === 'before') {
      chCard.append(h('h2', { text: ch.total + '日チャレンジ' }), h('div', { class: 'big-num', text: 'あと ' + ch.daysUntil + ' 日で開始' }), h('p', { class: 'sub', text: '開始日 ' + lab(ch.start, true) }));
    } else {
      chCard.append(h('div', { class: 'row between' }, h('h2', { text: ch.total + '日チャレンジ', style: { margin: 0 } }), h('button', { class: 'btn small ghost', text: '設定', onclick: () => openChallengeSetup() })),
        ch.state === 'finished' ? h('div', { class: 'hero' }, 'おつかれさま') : h('div', { class: 'hero', 'aria-label': ch.dayNo + '日目' }, String(ch.dayNo), h('small', { text: ' 日目 / ' + ch.total })),
        h('div', { class: 'row', style: { gap: '22px', marginTop: '6px' } },
          h('div', null, h('div', { class: 'sub small', text: '連続' }), h('div', { class: 'big-num', style: { fontSize: '34px' } }, String(ch.streak), h('small', { text: ' 日' }))),
          h('div', null, h('div', { class: 'sub small', text: ch.state === 'finished' ? '続けた日' : '残り' }), h('div', { class: 'big-num', style: { fontSize: '34px' } }, String(ch.state === 'finished' ? ch.done : ch.remaining), h('small', { text: ' 日' })))),
        h('div', { class: 'dots', 'aria-hidden': 'true' }, ch.cells.map((x) => h('i', { class: (x.checked ? 'on ' : '') + (x.today ? 'today' : '') }))));
    }
    c.append(chCard);
    c.append(h('div', { class: 'card' }, h('h2', { text: '今日の運動' }), exerciseChips(T, () => renderView()), h('p', { class: 'sub small', style: { margin: '8px 0 0' }, text: 'どれか1つ押すと「続けた日」になります(休養も数えます)。' })));
    const w = calc.periodStats(S.records, 'weight', T);
    const fat = calc.periodStats(S.records, 'fat', T), mus = calc.periodStats(S.records, 'muscle', T);
    const big = w.thisWeek || w.lastWeek;
    const wc = h('div', { class: 'card' }, h('h2', { text: w.thisWeek ? '今週の平均' : '先週の平均' }),
      big ? h('div', { class: 'big-num mono', 'aria-label': f1(big.avg) + 'キログラム' }, f1(big.avg), h('small', { text: ' kg' })) : h('p', { class: 'sub', text: 'まだ平均を出せる記録がありません。記録がたまると、ここに週の平均が出ます。' }));
    if (big) {
      const rows = [];
      if (w.thisWeek && w.lastWeek) rows.push(['先週の平均', f1(w.lastWeek.avg) + ' kg', '差 ' + signed(Math.round((w.thisWeek.avg - w.lastWeek.avg) * 10) / 10) + ' kg']);
      if (w.last7) rows.push(['直近7日の平均', f1(w.last7.avg) + ' kg']);
      if (fat.thisWeek || fat.last7) rows.push(['体脂肪率(' + (fat.thisWeek ? '今週' : '直近7日') + ')', f1((fat.thisWeek || fat.last7).avg) + ' %']);
      if (mus.thisWeek || mus.last7) rows.push(['骨格筋率(' + (mus.thisWeek ? '今週' : '直近7日') + ')', f1((mus.thisWeek || mus.last7).avg) + ' %']);
      wc.append(h('div', { style: { marginTop: '8px' } }, rows.map((r) => h('div', { class: 'kv' }, h('span', { text: r[0] }), h('span', { class: 'mono' }, r[1], r[2] ? h('span', { class: 'sub small', text: '  ' + r[2] }) : null)))));
      wc.append(h('p', { class: 'sub small', style: { margin: '8px 0 0' }, text: w.todayValue !== null ? '今日の記録 ' + f1(w.todayValue) + ' kg(日ごとの上下は目安です)' : '日ごとの上下より、週の平均の流れを見ます。' }));
    }
    c.append(wc);
    c.append(h('button', { class: 'btn primary big', text: '体重を記録する', onclick: () => openEntry({ date: T }) }));
    c.append(h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn grow', text: '今日は測定なし', onclick: async () => {
        if (recordsOn(T).some((r) => r.flags && r.flags.none)) { toast('今日は「測定なし」で記録済みです'); return; }
        const rec = await saveRecord({ date: T, timing: '', note: '', flags: { none: true }, source: 'manual', weight: null, fat: null, muscle: null, water: null, bone: null, bmr: null, bmi: null });
        refreshAll(); toast('「測定なし」で記録しました', async () => { await removeItem('records', S.records, rec.id); refreshAll(); });
      } }),
      h('button', { class: 'btn grow', text: '食事を記録', onclick: () => openMealEditor({ date: T }) })));
    c.append(h('button', { class: 'btn', style: { width: '100%', marginTop: '10px' }, text: '今日の痛み・体調メモ', onclick: () => openDay(T) }));
    c.append(h('p', { class: 'foot', text: 'このアプリは記録のためのもので、医療の診断・治療の代わりではありません。' }));
  }
  function openChallengeSetup() {
    const page = openPage('チャレンジの設定', (body) => {
      const d = h('input', { type: 'date', value: S.settings.challengeStart || today(), 'aria-label': '開始日' });
      const n = h('input', { type: 'text', inputmode: 'numeric', value: String(S.settings.challengeDays || 30), 'aria-label': '日数' });
      const msg = h('p', { class: 'sub', role: 'status' });
      body.append(h('label', { class: 'f', text: '開始日(この日が1日目)' }), d, h('label', { class: 'f', text: '日数' }), n, msg, h('div', { class: 'gap' }),
        h('button', { class: 'btn primary big', text: '保存する', onclick: async () => {
          const days = parseNum(n.value);
          if (!calc.isRealKey(d.value) || !days || days < 1 || days > 365) { msg.textContent = '開始日と、1〜365の日数を入れてください。'; return; }
          await setSetting('challengeStart', d.value); await setSetting('challengeDays', Math.round(days)); page.close(); refreshAll();
        } }),
        S.settings.challengeStart ? h('button', { class: 'btn danger', style: { width: '100%', marginTop: '10px' }, text: 'チャレンジをやめる(運動の記録は残ります)', onclick: async () => { await setSetting('challengeStart', null); page.close(); refreshAll(); } }) : null);
    }, { static: true });
  }

  // ---------- きろく(一覧・カレンダー) ----------
  function viewLog(c) {
    c.append(h('h1', { text: 'きろく' }), h('div', { class: 'seg', role: 'group', 'aria-label': '表示' },
      ['list', 'cal'].map((k) => h('button', { 'aria-pressed': String(UI.logMode === k), text: k === 'list' ? '一覧' : 'カレンダー', onclick: () => { UI.logMode = k; renderView(); } }))), h('div', { class: 'gap' }));
    if (UI.logMode === 'cal') return viewCal(c);
    if (!S.records.length) { c.append(h('div', { class: 'card' }, h('p', { text: 'まだ記録がありません。' }), h('p', { class: 'sub', text: 'ホームの「体重を記録する」から始められます。以前の記録がCSVにあるときは、「もっと」→「データ」から取り込めます。' }))); return; }
    const recs = S.records.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
    const card = h('div', { class: 'card' }); const list = h('div', { class: 'list' });
    let lastMonth = '';
    recs.slice(0, UI.listLimit).forEach((r) => {
      const m = r.date.slice(0, 7);
      if (m !== lastMonth) { list.append(h('div', { class: 'mon', text: m.replace('-', '年') + '月' })); lastMonth = m; }
      list.append(recordRow(r, false));
    });
    card.append(list); c.append(card);
    if (recs.length > UI.listLimit) c.append(h('button', { class: 'btn', style: { width: '100%' }, text: 'さらに表示(' + (recs.length - UI.listLimit) + '件)', onclick: () => { UI.listLimit += 60; renderView(); } }));
  }
  function viewCal(c) {
    const ym = UI.calMonth, y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
    const shift = (n) => { const d = new Date(y, mo - 1 + n, 1); UI.calMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); renderView(); };
    c.append(h('div', { class: 'row between', style: { marginBottom: '8px' } }, h('button', { class: 'btn small', text: '‹', 'aria-label': '前の月', onclick: () => shift(-1) }), h('b', { text: y + '年' + mo + '月' }), h('button', { class: 'btn small', text: '›', 'aria-label': '次の月', onclick: () => shift(1) })));
    const daily = calc.dailyValues(S.records, 'weight');
    const grid = h('div', { class: 'cal' }, ['月', '火', '水', '木', '金', '土', '日'].map((w) => h('div', { class: 'h', text: w })));
    const first = new Date(y, mo - 1, 1), pad = (first.getDay() + 6) % 7, nd = new Date(y, mo, 0).getDate();
    for (let i = 0; i < pad; i++) grid.append(h('button', { class: 'empty', disabled: true, tabindex: '-1', 'aria-hidden': 'true' }));
    for (let d = 1; d <= nd; d++) {
      const key = ym + '-' + String(d).padStart(2, '0');
      const rs = recordsOn(key); const ex = dayOf(key).exercise || {};
      const allNone = rs.length > 0 && rs.every((r) => r.flags && r.flags.none);
      const marks = EX.filter((e) => e[0] !== 'rest' && ex[e[0]]).map((e) => e[2]).join('');
      const v = daily[key]; const refV = rs.find((r) => r.flags && r.flags.reference && typeof r.weight === 'number');
      grid.append(h('button', { class: (allNone ? 'none ' : '') + (key === today() ? 'today' : ''), 'data-date': key, onclick: () => openDay(key),
        'aria-label': lab(key) + (v !== undefined ? ' ' + f1(v) + 'キログラム' : allNone ? ' 測定なし' : '') + (marks ? ' 運動あり' : '') },
        h('b', { text: String(d) }), v !== undefined ? h('span', { class: 'mono', text: f1(v) }) : refV ? h('span', { class: 'mono faint', text: f1(refV.weight) }) : allNone ? h('span', { text: '−' }) : null, marks ? h('span', { class: 'mk', text: marks }) : null));
    }
    c.append(h('div', { class: 'card' }, grid, h('p', { class: 'sub small', style: { margin: '10px 0 0' }, text: '数字は体重(kg)。薄い日は測定なし・参考値。🏃⚽🏋は運動した日。日付をタップで詳細。' })));
  }

  // ---------- グラフ ----------
  const METRICS = { weight: ['体重', 'kg'], fat: ['体脂肪率', '%'], muscle: ['骨格筋率', '%'] };
  const RANGES = [['14', '2週間'], ['30', '1か月'], ['90', '3か月'], ['all', '全期間']];
  let chartGeo = null;
  function viewGraph(c) {
    const f = UI.gMetric;
    c.append(h('h1', { text: 'グラフ' }),
      h('div', { class: 'seg', role: 'group', 'aria-label': '項目' }, Object.keys(METRICS).map((k) => h('button', { 'aria-pressed': String(f === k), text: METRICS[k][0], onclick: () => { UI.gMetric = k; renderView(); } }))), h('div', { class: 'gap' }),
      h('div', { class: 'seg', role: 'group', 'aria-label': '期間' }, RANGES.map((r) => h('button', { 'aria-pressed': String(UI.gRange === r[0]), text: r[1], onclick: () => { UI.gRange = r[0]; renderView(); } }))), h('div', { class: 'gap' }));
    const cv = h('canvas', { class: 'chart', role: 'img', 'aria-label': METRICS[f][0] + 'のグラフ' });
    const info = h('div', { class: 'sub small mono', style: { minHeight: '20px', marginTop: '6px' }, role: 'status' });
    c.append(h('div', { class: 'card' }, cv, info, h('div', { class: 'legend' }, h('span', null, h('i'), '7日移動平均'), h('span', null, h('i', { class: 'p' }), '日ごとの値'), h('span', null, h('i', { class: 'r' }), '参考値(平均に入りません)'))));
    requestAnimationFrame(() => drawChart(cv, info, null));
    const mv = (e) => { if (!chartGeo) return; const r = cv.getBoundingClientRect(); drawChart(cv, info, e.clientX - r.left); };
    cv.addEventListener('pointerdown', mv); cv.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'mouse') mv(e); });
    // サマリー
    const T = today(), st = calc.periodStats(S.records, f, T), u = METRICS[f][1];
    const rows = [];
    rows.push(['今週の平均', st.thisWeek ? f1(st.thisWeek.avg) + ' ' + u : '—']);
    rows.push(['先週の平均', st.lastWeek ? f1(st.lastWeek.avg) + ' ' + u : '—']);
    rows.push(['今月の平均', st.thisMonth ? f1(st.thisMonth.avg) + ' ' + u : '—']);
    rows.push(['先月の平均', st.prevMonth ? f1(st.prevMonth.avg) + ' ' + u : '—']);
    rows.push(['最低', st.min ? f1(st.min.v) + ' ' + u + '(' + lab(st.min.date) + ')' : '—']);
    rows.push(['最高', st.max ? f1(st.max.v) + ' ' + u + '(' + lab(st.max.date) + ')' : '—']);
    if (f === 'weight') {
      const ch = calc.changeFromStart(S.records, S.settings, T);
      rows.push([ch && ch.source === 'first' ? '最初の記録からの変化' : '開始時' + (ch ? f1(ch.start) + 'kg' : '') + 'からの変化', ch ? signed(ch.diff) + ' kg' + (ch.basis === 'last7' ? '(直近7日の平均で比較)' : '(最新の値で比較)') : '—']);
    }
    if (f === 'weight' && typeof S.settings.goalWeight === 'number') {
      const cur = st.last7 ? st.last7.avg : st.latest ? st.latest.v : null;
      rows.push(['目標体重' + f1(S.settings.goalWeight) + 'kg', cur === null ? '—' : 'あと ' + f1(Math.max(0, cur - S.settings.goalWeight)) + ' kg(直近7日の平均から)']);
    }
    c.append(h('div', { class: 'card' }, h('h2', { text: 'サマリー(' + METRICS[f][0] + ')' }), rows.map((r) => h('div', { class: 'kv' }, h('span', { text: r[0] }), h('span', { class: 'mono', text: r[1] })))),
      h('p', { class: 'foot', text: '測定なし・参考値の日は平均に入れていません。' }));
  }
  function drawChart(cv, info, hoverX) {
    const css = getComputedStyle(document.documentElement), col = (n) => css.getPropertyValue(n).trim();
    const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!W) return;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const f = UI.gMetric, T = today();
    const withVal = S.records.filter((r) => typeof r[f] === 'number' && r.date && !(r.flags && r.flags.none));
    const daily = calc.dailyValues(S.records, f), ma = calc.movingAvg(daily, 7);
    let from;
    if (UI.gRange === 'all') { const ks = withVal.map((r) => r.date).sort(); from = ks[0] || T; } else from = calc.addDays(T, -(Number(UI.gRange) - 1));
    const to = T;
    const pts = Object.keys(daily).filter((k) => k >= from && k <= to).map((k) => ({ d: k, v: daily[k] }));
    const refs = withVal.filter((r) => r.flags && r.flags.reference && r.date >= from && r.date <= to);
    const mas = ma.filter((p) => p.date >= from && p.date <= to);
    g.font = '12px -apple-system, "Hiragino Sans", sans-serif'; g.textBaseline = 'middle';
    if (!pts.length) { g.fillStyle = col('--sub'); g.textAlign = 'center'; g.fillText('この期間の記録はまだありません', W / 2, H / 2); chartGeo = null; info.textContent = ''; return; }
    const all = pts.map((p) => p.v).concat(mas.map((p) => p.avg)); // 参考値の極端な値で軸が潰れないよう、軸は通常の値で決める
    let lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (hi - lo < 1) { const m = (hi + lo) / 2; lo = m - 0.5; hi = m + 0.5; }
    const padv = (hi - lo) * 0.12; lo -= padv; hi += padv;
    const L = 38, R = 10, Tp = 10, B = 24, pw = W - L - R, ph = H - Tp - B;
    const span = Math.max(1, calc.diffDays(from, to));
    const X = (d) => L + (calc.diffDays(from, d) / span) * pw, Y = (v) => Tp + (1 - (v - lo) / (hi - lo)) * ph;
    g.strokeStyle = col('--grid'); g.fillStyle = col('--sub'); g.lineWidth = 1; g.textAlign = 'right';
    for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4, y = Y(v); g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.fillText(v.toFixed(1), L - 6, y); }
    g.textAlign = 'center';
    const nt = W < 340 ? 3 : 4;
    for (let i = 0; i <= nt; i++) { const d = calc.addDays(from, Math.round((span * i) / nt)), p = calc.parseKey(d); const x = X(d); g.fillText((p.getMonth() + 1) + '/' + p.getDate(), Math.min(W - 16, Math.max(L + 8, x)), H - 8); }
    // 参考値(薄い輪)
    g.strokeStyle = col('--pt'); g.lineWidth = 1.5; g.globalAlpha = 0.55;
    refs.filter((r) => r[f] >= lo && r[f] <= hi).forEach((r) => { g.beginPath(); g.arc(X(r.date), Y(r[f]), 3.5, 0, Math.PI * 2); g.stroke(); });
    // 日ごとの点
    g.globalAlpha = 0.7; g.fillStyle = col('--pt');
    pts.forEach((p) => { g.beginPath(); g.arc(X(p.d), Y(p.v), 2.6, 0, Math.PI * 2); g.fill(); });
    // 移動平均
    g.globalAlpha = 1; g.strokeStyle = col('--accent'); g.lineWidth = 2.8; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath(); mas.forEach((p, i) => { const x = X(p.date), y = Y(p.avg); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
    if (mas.length === 1) { g.fillStyle = col('--accent'); g.beginPath(); g.arc(X(mas[0].date), Y(mas[0].avg), 4, 0, Math.PI * 2); g.fill(); }
    chartGeo = { X, from, span, L, pw };
    // 選んだ日
    if (hoverX != null) {
      const dayIdx = Math.max(0, Math.min(span, Math.round(((hoverX - L) / pw) * span))), d = calc.addDays(from, dayIdx);
      const x = X(d); g.strokeStyle = col('--sub'); g.globalAlpha = 0.5; g.lineWidth = 1; g.beginPath(); g.moveTo(x, Tp); g.lineTo(x, Tp + ph); g.stroke(); g.globalAlpha = 1;
      const m = ma.find((p) => p.date === d), ref = refs.find((r) => r.date === d), u = METRICS[f][1];
      info.textContent = lab(d) + '  ' + (daily[d] !== undefined ? '日の値 ' + f1(daily[d]) + u : ref ? '参考値 ' + f1(ref[f]) + u : '記録なし') + (m ? '  /  7日平均 ' + f1(m.avg) + u : '');
    } else info.textContent = '日付の近くをタップすると、その日の値が見えます。';
  }
  window.addEventListener('resize', () => { if (UI.tab === 'graph') renderView(); });

  // ---------- 健康診断・受診メモ(常に自分だけ) ----------
  const H_KINDS = ['健康診断', '受診', 'メモ', '次回の予定'];
  const H_SUGG = ['BMI', 'LDL', '中性脂肪', 'HbA1c', '血糖', '血圧', '判定'];
  function openHealthPage() {
    openPage('健康診断・受診メモ', (body) => {
      body.append(h('p', { class: 'sub small', text: 'このメモは、今後共有機能ができても共有されません(常にあなただけ)。項目は自由に足せます。' }));
      body.append(h('button', { class: 'btn primary', style: { width: '100%', marginBottom: '14px' }, text: '＋ メモを追加', onclick: () => openHealthEditor({ date: today(), kind: '健康診断', title: '', items: [], memo: '', nextDate: '' }) }));
      const next = S.health.filter((x) => x.nextDate && x.nextDate >= today()).sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1))[0];
      if (next) body.append(h('div', { class: 'banner' }, h('b', { text: '次回の予定' }), lab(next.nextDate, true) + (next.title ? '(' + next.title + ')' : '')));
      if (!S.health.length) { body.append(h('div', { class: 'card' }, h('p', { class: 'sub', text: 'まだメモがありません。健康診断の結果や、受診して言われたことを残せます。' }))); return; }
      S.health.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((x) => {
        body.append(h('button', { class: 'card', style: { width: '100%', textAlign: 'left' }, onclick: () => openHealthEditor(x), 'aria-label': lab(x.date, true) + ' ' + (x.title || x.kind) + ' を開く' },
          h('div', { class: 'row between' }, h('b', { text: x.title || x.kind }), h('span', { class: 'sub small', text: lab(x.date, true) })), h('span', { class: 'tag', text: x.kind, style: { marginLeft: 0 } }),
          (x.items || []).slice(0, 8).map((it) => h('div', { class: 'kv' }, h('span', { text: it.name }), h('span', { text: it.value }))),
          x.memo ? h('p', { class: 'sub small', style: { margin: '8px 0 0', whiteSpace: 'pre-wrap' }, text: x.memo }) : null,
          x.nextDate ? h('p', { class: 'small', style: { margin: '6px 0 0' }, text: '次回: ' + lab(x.nextDate, true) }) : null));
      });
    });
  }
  function openHealthEditor(entry) {
    const isNew = !entry.id;
    const page = openPage(isNew ? 'メモを追加' : 'メモを直す', (body) => {
      const e = Object.assign({}, entry, { items: (entry.items || []).map((i) => ({ name: i.name, value: i.value })) });
      const date = h('input', { type: 'date', value: e.date, 'aria-label': '日付' });
      const title = h('input', { type: 'text', value: e.title || '', maxlength: '80', placeholder: '例: 会社の健康診断', 'aria-label': 'タイトル' });
      const memo = h('textarea', { maxlength: '3000', value: e.memo || '', 'aria-label': 'メモ', placeholder: '言われたこと、気になること' });
      const nxt = h('input', { type: 'date', value: e.nextDate || '', 'aria-label': '次回の予定日' });
      const itemsBox = h('div');
      const drawItems = () => {
        itemsBox.replaceChildren(...e.items.map((it, i) => {
          const n = h('input', { type: 'text', value: it.name, maxlength: '40', placeholder: '項目', 'aria-label': '項目名' }), v = h('input', { type: 'text', value: it.value, maxlength: '60', placeholder: '値・判定', 'aria-label': '値' });
          n.addEventListener('input', () => { it.name = n.value; }); v.addEventListener('input', () => { it.value = v.value; });
          return h('div', { class: 'row', style: { marginBottom: '8px' } }, h('div', { class: 'grow' }, n), h('div', { class: 'grow' }, v), h('button', { class: 'btn small ghost', text: '✕', 'aria-label': '項目を消す', onclick: () => { e.items.splice(i, 1); drawItems(); } }));
        }), h('div', { class: 'chips', style: { marginTop: '6px' } }, H_SUGG.map((s) => h('button', { class: 'chip sm', text: '＋ ' + s, onclick: () => { e.items.push({ name: s, value: '' }); drawItems(); } })), h('button', { class: 'chip sm', text: '＋ 自由に追加', onclick: () => { e.items.push({ name: '', value: '' }); drawItems(); } })));
      };
      drawItems();
      body.append(h('label', { class: 'f', text: '種類' }), chipGroup(H_KINDS, e.kind, (v) => { e.kind = v || e.kind; }), h('label', { class: 'f', text: '日付' }), date, h('label', { class: 'f', text: 'タイトル' }), title,
        h('label', { class: 'f', text: '項目と値(自由に追加)' }), itemsBox, h('label', { class: 'f', text: 'メモ' }), memo, h('label', { class: 'f', text: '次回の検査・受診の予定日(任意)' }), nxt, h('div', { class: 'gap' }),
        h('button', { class: 'btn primary big', text: '保存する', onclick: async () => {
          if (!calc.isRealKey(date.value)) { toast('日付を選んでください'); return; }
          const next = Object.assign({}, e, { date: date.value, title: title.value.trim(), memo: memo.value, nextDate: nxt.value || '', items: e.items.filter((i) => i.name.trim() || i.value.trim()) });
          await saveItem('health', S.health, next); page.close(); refreshAll(); toast('保存しました');
        } }));
      if (!isNew) body.append(h('button', { class: 'btn danger', style: { width: '100%', marginTop: '10px' }, text: 'このメモを削除', onclick: async () => { if (await confirmBox('このメモを削除しますか?', '削除する', true, '元に戻せません。')) { await removeItem('health', S.health, entry.id); page.close(); refreshAll(); } } }));
    }, { static: true });
  }

  // ---------- 進捗写真(常に自分だけ) ----------
  function openProgressPage() {
    const sel = []; let cmpMode = false;
    openPage('進捗写真', (body, page) => {
      body.append(h('p', { class: 'sub small', text: '写真はこの端末の中だけに保存されます。共有の対象にはなりません。2週間に1回ほどの全身写真を、日付つきで並べて見比べられます。' }),
        h('div', { class: 'row', style: { marginBottom: '12px' } }, h('button', { class: 'btn primary grow', text: '＋ 写真を追加', onclick: () => openProgressEditor({ date: today() }) }),
          S.progress.length >= 2 ? h('button', { class: 'btn grow', 'aria-pressed': String(cmpMode), text: cmpMode ? '比べるをやめる' : '並べて比べる', onclick: () => { cmpMode = !cmpMode; sel.length = 0; page.refresh(); } }) : null));
      if (!S.progress.length) { body.append(h('div', { class: 'card' }, h('p', { class: 'sub', text: 'まだ写真がありません。' }))); return; }
      if (cmpMode) {
        body.append(h('p', { class: 'sub small', role: 'status', text: sel.length < 2 ? '比べたい写真を2枚タップしてください(' + sel.length + '/2)' : '' }));
        if (sel.length === 2) {
          const [a, b] = sel.map((id) => S.progress.find((p) => p.id === id)).sort((x, y) => (x.date < y.date ? -1 : 1));
          const big = (p) => { const im = h('img', { alt: lab(p.date, true) + 'の写真' }); db.image(p.photoId).then((bl) => { if (bl) im.src = blobUrl('f' + p.photoId, bl); }); return h('div', null, im, h('div', { text: lab(p.date, true) })); };
          body.append(h('div', { class: 'card' }, h('div', { class: 'cmp' }, big(a), big(b)), h('p', { class: 'sub', style: { textAlign: 'center', margin: '8px 0 0' }, text: calc.diffDays(a.date, b.date) + ' 日あいだ' })));
        }
      }
      const grid = h('div', { class: 'thumbs' });
      S.progress.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((p) => {
        grid.append(h('button', { class: sel.includes(p.id) ? 'sel' : '', 'aria-label': lab(p.date, true) + 'の写真', 'aria-pressed': cmpMode ? String(sel.includes(p.id)) : null, onclick: () => {
          if (!cmpMode) return openProgressEditor(p);
          const i = sel.indexOf(p.id); if (i >= 0) sel.splice(i, 1); else { if (sel.length === 2) sel.shift(); sel.push(p.id); } page.refresh();
        } }, thumbImg(p.photoId, lab(p.date, true)), h('span', { class: 'cap', text: lab(p.date, true) })));
      });
      body.append(grid);
    });
  }
  function openProgressEditor(p) {
    const isNew = !p.id;
    const page = openPage(isNew ? '進捗写真を追加' : '進捗写真', (body) => {
      const date = h('input', { type: 'date', value: p.date, 'aria-label': '撮った日' });
      const note = h('textarea', { maxlength: '500', value: p.note || '', 'aria-label': 'メモ', placeholder: '例: 朝、同じ場所で' });
      const picker = photoPicker(p.photoId, () => {}); const msg = h('p', { class: 'sub', role: 'status' });
      if (!isNew) { const im = h('img', { alt: '進捗写真', style: { width: '100%', borderRadius: '12px' } }); db.image(p.photoId).then((bl) => { if (bl) im.src = blobUrl('f' + p.photoId, bl); }); body.append(im); }
      body.append(h('label', { class: 'f', text: isNew ? '写真' : '写真を入れ替える' }), picker.el, h('label', { class: 'f', text: '撮った日' }), date, h('label', { class: 'f', text: 'メモ' }), note, msg, h('div', { class: 'gap' }),
        h('button', { class: 'btn primary big', text: '保存する', onclick: async () => {
          if (!calc.isRealKey(date.value)) { msg.textContent = '日付を選んでください。'; return; }
          if (!picker.pending && !p.photoId) { msg.textContent = '写真を選んでください。'; return; }
          const old = p.photoId; const pid = await picker.commit();
          await saveItem('progress', S.progress, Object.assign({}, p, { date: date.value, note: note.value.trim(), photoId: pid }));
          if (old && old !== pid) await db.delImage(old);
          page.close(); refreshAll(); toast('保存しました'); askPersist();
        } }));
      if (!isNew) body.append(h('button', { class: 'btn danger', style: { width: '100%', marginTop: '10px' }, text: 'この写真を削除', onclick: async () => { if (await confirmBox('この写真を削除しますか?', '削除する', true, '端末から消えます。元に戻せません。')) { await db.delImage(p.photoId); await removeItem('progress', S.progress, p.id); page.close(); refreshAll(); } } }));
    }, { static: true });
  }

  // ---------- データ(取り込み・書き出し・復元) ----------
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function readText(file, max) {
    return new Promise((res, rej) => {
      if (file.size > max) return rej(new Error('large'));
      const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(file);
    });
  }
  function blobToDataUrl(b) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); }); }
  function dataUrlToBlob(u) {
    const m = /^data:([^;,]+);base64,(.*)$/.exec(u); if (!m) throw new Error('bad');
    const bin = atob(m[2]), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: m[1] });
  }
  async function importCsvFile(file, page) {
    let text;
    try { text = await readText(file, 5 * 1024 * 1024); } catch (e) { toast('ファイルを読めませんでした(5MBまで)'); return; }
    const res = csv.importCsv(text);
    if (res.error) { await confirmBox('取り込めませんでした', 'とじる', false, res.error); return; }
    const have = new Set(S.records.map(csv.dedupKey));
    const fresh = [], seen = new Set(); let dup = 0;
    res.records.forEach((r) => { const k = csv.dedupKey(r); if (have.has(k) || seen.has(k)) dup++; else { seen.add(k); fresh.push(r); } });
    const lines = [fresh.length + ' 件を追加します。', dup ? '同じ内容の ' + dup + ' 件は、重なるので追加しません。' : '',
      res.startWeight !== null ? (typeof S.settings.startWeight === 'number' ? '開始時の体重 ' + f1(res.startWeight) + 'kg の行がありました(すでに ' + f1(S.settings.startWeight) + 'kg が設定済みのため変更しません)。' : '開始時の体重 ' + f1(res.startWeight) + 'kg を設定します。') : '',
      res.skipped.length ? '読めなかった行: ' + res.skipped.length + ' 件(' + res.skipped.slice(0, 3).map((s) => s.line + '行目').join('、') + (res.skipped.length > 3 ? ' ほか' : '') + ')' : ''].concat(res.notes).filter(Boolean);
    if (!fresh.length && (res.startWeight === null || typeof S.settings.startWeight === 'number')) { await confirmBox('追加する記録がありません', 'とじる', false, lines.join('\n')); return; }
    if (!(await confirmBox('CSVを取り込みますか?', '取り込む', false, lines.join('\n')))) return;
    const t0 = Date.now(); fresh.forEach((r, i) => { r.createdAt = t0 + i; });
    const keys = await db.putMany('records', fresh); fresh.forEach((r, i) => { r.id = keys[i]; S.records.push(r); });
    if (res.startWeight !== null && typeof S.settings.startWeight !== 'number') await setSetting('startWeight', res.startWeight);
    refreshAll(); toast(fresh.length + ' 件を取り込みました');
  }
  async function buildExport(kind, withPhotos) {
    const T = today();
    if (kind === 'csv') return { name: 'bodylog_記録_' + T + '.csv', type: 'text/csv', blob: new Blob(['﻿' + csv.toCsv(S.records, S.settings.startWeight)], { type: 'text/csv' }) };
    const out = { app: 'bodylog', schema: 1, exportedAt: new Date().toISOString(), settings: S.settings, records: S.records, days: Object.keys(S.days).map((k) => S.days[k]), meals: S.meals, health: S.health, progress: S.progress, images: [], photosIncluded: !!withPhotos };
    if (withPhotos) {
      const ids = new Set(); S.meals.concat(S.progress).forEach((x) => { if (x.photoId) ids.add(x.photoId); });
      for (const id of ids) { const b = await db.image(id); if (b) out.images.push({ id, data: await blobToDataUrl(b) }); }
    }
    return { name: 'bodylog_バックアップ_' + T + '.json', type: 'application/json', blob: new Blob([JSON.stringify(out)], { type: 'application/json' }) };
  }
  function offerFile(file) {
    return new Promise((resolve) => {
      const kb = Math.max(1, Math.round(file.blob.size / 1024));
      const done = (v) => { m.remove(); resolve(v); };
      const save = async () => {
        const f = new File([file.blob], file.name, { type: file.type });
        try {
          if (isIOS() && navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f] }); done(true); return; }
        } catch (e) { if (e && e.name === 'AbortError') return; }
        const u = URL.createObjectURL(file.blob); const a = h('a', { href: u, download: file.name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 10000); done(true);
      };
      const m = h('div', { class: 'overlay modal', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'box' },
        h('p', { style: { margin: '0 0 6px', fontWeight: '700' }, text: 'ファイルの準備ができました' }), h('p', { class: 'sub', style: { margin: '0 0 14px', wordBreak: 'break-all' }, text: file.name + '(約 ' + kb.toLocaleString('ja-JP') + ' KB)' }),
        h('p', { class: 'sub small', text: isIOS() ? '「ファイルに保存」を選ぶと、iPhoneの中に残せます。' : '' }),
        h('div', { class: 'row' }, h('button', { class: 'btn grow', text: 'やめる', onclick: () => done(false) }), h('button', { class: 'btn primary grow', text: '保存する', onclick: save }))));
      $('#overlays').append(m);
    });
  }
  async function doExport(kind, withPhotos, btn) {
    btn.disabled = true;
    try { const f = await buildExport(kind, withPhotos); if (await offerFile(f)) { await setSetting('lastExport', Date.now()); refreshAll(); toast('書き出しました'); } }
    catch (e) { toast('書き出せませんでした'); } finally { btn.disabled = false; }
  }
  async function restoreJson(file) {
    let obj;
    try { obj = JSON.parse(await readText(file, 300 * 1024 * 1024)); } catch (e) { await confirmBox('読めませんでした', 'とじる', false, 'バックアップのJSONファイルではないようです。'); return; }
    if (!obj || obj.app !== 'bodylog' || !Array.isArray(obj.records)) { await confirmBox('読めませんでした', 'とじる', false, 'このアプリのバックアップではないようです。'); return; }
    const msg = '記録 ' + obj.records.length + ' 件、食事 ' + (obj.meals || []).length + ' 件、進捗写真 ' + (obj.progress || []).length + ' 件、健康診断メモ ' + (obj.health || []).length + ' 件。' + (obj.photosIncluded ? '' : '\n(このバックアップには写真が入っていません)') + '\n今この端末にあるデータは、すべて置き換わります。';
    if (!(await confirmBox('バックアップから復元しますか?', '置き換えて復元', true, msg))) return;
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null), str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const recs = obj.records.filter((r) => r && calc.isRealKey(r.date)).map((r) => ({ date: r.date, timing: str(r.timing, 60), note: str(r.note, 500), weight: num(r.weight), fat: num(r.fat), muscle: num(r.muscle), water: num(r.water), bone: num(r.bone), bmr: num(r.bmr), bmi: num(r.bmi), flags: { reference: !!(r.flags && r.flags.reference), estimated: !!(r.flags && r.flags.estimated), none: !!(r.flags && r.flags.none) }, source: str(r.source, 10) || 'restore', createdAt: num(r.createdAt) || Date.now() }));
    recs.forEach((r) => { Object.keys(r.flags).forEach((k) => { if (!r.flags[k]) delete r.flags[k]; }); });
    await db.clearAll();
    const idMap = {};
    for (const im of obj.images || []) { try { const b = dataUrlToBlob(im.data); const bmp = await decode(b); idMap[im.id] = await db.addImage(b, await shrink(bmp, 320, 0.7)); } catch (e) { /* 読めない写真はとばす */ } }
    const days = (obj.days || []).filter((d) => d && calc.isRealKey(d.date)).map((d) => ({ date: d.date, exercise: d.exercise && typeof d.exercise === 'object' ? d.exercise : {}, pain: Array.isArray(d.pain) ? d.pain.filter((p) => p && typeof p.place === 'string').map((p) => ({ place: p.place.slice(0, 20), level: Math.max(0, Math.min(10, Number(p.level) || 0)) })) : [], memo: str(d.memo, 1000), intake: d.intake && typeof d.intake === 'object' ? { kcalMin: num(d.intake.kcalMin), kcalMax: num(d.intake.kcalMax), protein: num(d.intake.protein), approx: true } : undefined }));
    const meals = (obj.meals || []).filter((m) => m && calc.isRealKey(m.date)).map((m) => ({ date: m.date, slot: str(m.slot, 10), time: str(m.time, 5), memo: str(m.memo, 1000), kcal: num(m.kcal), protein: num(m.protein), approx: !!m.approx, kcalEst: num(m.kcalEst), nutritionNote: str(m.nutritionNote, 1000), visibility: 'private', photoId: idMap[m.photoId] || null, createdAt: num(m.createdAt) || Date.now() }));
    const health = (obj.health || []).filter((x) => x && calc.isRealKey(x.date)).map((x) => ({ date: x.date, kind: str(x.kind, 10) || 'メモ', title: str(x.title, 80), memo: str(x.memo, 3000), nextDate: calc.isRealKey(x.nextDate) ? x.nextDate : '', items: Array.isArray(x.items) ? x.items.map((i) => ({ name: str(i && i.name, 40), value: str(i && i.value, 60) })) : [], createdAt: num(x.createdAt) || Date.now() }));
    const progress = (obj.progress || []).filter((x) => x && calc.isRealKey(x.date) && idMap[x.photoId]).map((x) => ({ date: x.date, note: str(x.note, 500), photoId: idMap[x.photoId], createdAt: num(x.createdAt) || Date.now() }));
    await db.putMany('records', recs); await db.putMany('days', days); await db.putMany('meals', meals); await db.putMany('health', health); await db.putMany('progress', progress);
    const st = obj.settings || {};
    for (const k of ['startWeight', 'challengeStart', 'challengeDays', 'installHintDismissed', 'sex'].concat(GOAL_FIELDS.map((f) => f[0]))) { if (st[k] !== undefined && st[k] !== null) await db.put('settings', { key: k, value: st[k] }); }
    await load(); refreshAll(); toast('復元しました');
  }
  function openDataPage() {
    openPage('データ', (body) => {
      const last = S.settings.lastExport;
      const csvIn = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', hidden: true, 'aria-label': 'CSVファイルを選ぶ' });
      const jsonIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': 'バックアップのファイルを選ぶ' });
      csvIn.addEventListener('change', async () => { const f = csvIn.files[0]; csvIn.value = ''; if (f) await importCsvFile(f); });
      jsonIn.addEventListener('change', async () => { const f = jsonIn.files[0]; jsonIn.value = ''; if (f) await restoreJson(f); });
      const photos = h('input', { type: 'checkbox', checked: true, 'aria-label': '写真も含める' });
      let jbtn, cbtn;
      body.append(
        h('div', { class: 'card' }, h('h2', { text: 'バックアップ' }), h('p', { class: 'sub small', style: { margin: '0 0 10px' }, text: last ? '最後の書き出し: ' + new Date(last).toLocaleString('ja-JP') : 'まだ書き出していません。' }),
          h('p', { class: 'small', style: { margin: '0 0 10px' }, text: 'データはこの端末の中だけにあります。端末の故障や、Safariのデータ消去に備えて、ときどき書き出してください。' }),
          jbtn = h('button', { class: 'btn primary', style: { width: '100%' }, text: 'バックアップを書き出す(JSON)', onclick: () => doExport('json', photos.checked, jbtn) }),
          h('label', { class: 'sw' }, photos, h('span', { text: '写真も含める(ファイルが大きくなります)' })),
          cbtn = h('button', { class: 'btn', style: { width: '100%' }, text: '体の記録をCSVで書き出す(Excel用)', onclick: () => doExport('csv', false, cbtn) }),
          h('p', { class: 'sub small', style: { margin: '8px 0 0' }, text: 'CSVには体の記録だけが入ります(運動・痛み・食事・写真は入りません。すべてはJSONで)。' })),
        h('div', { class: 'card' }, h('h2', { text: '取り込み' }), h('p', { class: 'small', style: { margin: '0 0 10px' }, text: 'これまでの記録がCSVにあるときは、ここから取り込めます。列: date, timing, weight_kg, body_fat_pct, skeletal_muscle_pct, water_pct, bone_kg, bmr_kcal, bmi, note, flags(reference / estimated_date / no_measurement / baseline を | で区切る)。同じ内容の行は重ならないようにしています。' }),
          h('button', { class: 'btn', style: { width: '100%' }, text: 'CSVを取り込む', onclick: () => csvIn.click() }), csvIn,
          h('hr'), h('p', { class: 'small', style: { margin: '0 0 10px' }, text: 'JSONのバックアップから戻す(新しい端末に移すときなど)。今あるデータは置き換わります。' }),
          h('button', { class: 'btn', style: { width: '100%' }, text: 'バックアップから復元する', onclick: () => jsonIn.click() }), jsonIn));
    }, { static: true });
  }

  // ---------- 設定 ----------
  function applyTheme() {
    let t = 'auto'; try { t = localStorage.getItem('bl-theme') || 'auto'; } catch (e) { /* 使えないときは自動 */ }
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
    return t;
  }
  async function askPersist() {
    try { if (navigator.storage && navigator.storage.persist && !S.persistAsked) { S.persistAsked = true; await navigator.storage.persist(); } } catch (e) { /* 失敗しても動作に影響なし */ }
  }
  const GOAL_FIELDS = [['heightCm', '身長', 'cm', 100, 250], ['age', '年齢', '歳', 1, 120], ['goalWeight', '目標体重', 'kg', 20, 300], ['idealWeight', '理想の体重', 'kg', 20, 300], ['kcalTarget', '1日の摂取目標', 'kcal', 500, 10000], ['kcalMin', '摂取の下限', 'kcal', 500, 10000], ['proteinTarget', 'たんぱく質の目安', 'g', 1, 1000], ['fatMin', '脂質の目安(下限)', 'g', 1, 500], ['fatMax', '脂質の目安(上限)', 'g', 1, 500], ['bmr', '基礎代謝(自分で入れる値)', 'kcal', 300, 5000], ['tdee', '1日の消費の目安 TDEE(自分で入れる値)', 'kcal', 500, 10000]];
  function goalsCard() {
    const inputs = {}, msg = h('p', { class: 'sub small', role: 'status' });
    let sex = S.settings.sex || '';
    const card = h('div', { class: 'card' }, h('h2', { text: '身体と目標(任意・目安)' }), h('p', { class: 'sub small', style: { margin: '0 0 6px' }, text: '空欄でかまいません。ここに入れた数字は、食事の目安の表示と、体重の「目標まで」の表示にだけ使います。基礎代謝・TDEEは自動計算せず、入れた値をそのまま保持します(参考: ミフリン式 男性 = 10×体重kg + 6.25×身長cm − 5×年齢 + 5)。' }));
    card.append(h('label', { class: 'f', text: '性別' }), chipGroup(['男性', '女性', '答えない'], sex, (v) => { sex = v; }));
    GOAL_FIELDS.forEach((f) => { inputs[f[0]] = h('input', { type: 'text', inputmode: 'decimal', value: typeof S.settings[f[0]] === 'number' ? String(S.settings[f[0]]) : '', 'aria-label': f[1] + '(' + f[2] + ')' }); card.append(h('label', { class: 'f', text: f[1] + '(' + f[2] + ')' }), inputs[f[0]]); });
    card.append(msg, h('button', { class: 'btn', style: { marginTop: '10px' }, text: '身体と目標を保存', onclick: async () => {
      const vals = {};
      for (const f of GOAL_FIELDS) { const v = parseNum(inputs[f[0]].value); if (v === undefined || (v !== null && (v < f[3] || v > f[4]))) { msg.textContent = f[1] + 'は ' + f[3] + '〜' + f[4] + ' の数字で入れてください(空欄でも可)。'; return; } vals[f[0]] = v; }
      for (const k of Object.keys(vals)) await setSetting(k, vals[k]);
      await setSetting('sex', sex || null); msg.textContent = '保存しました。'; renderView();
    } }));
    return card;
  }
  function openSettings() {
    openPage('設定', (body, page) => {
      const theme = applyTheme();
      const sw = h('input', { type: 'text', inputmode: 'decimal', value: typeof S.settings.startWeight === 'number' ? String(S.settings.startWeight) : '', placeholder: '例 93.0(空欄なら最初の記録)', 'aria-label': '開始時の体重' });
      const msg = h('p', { class: 'sub small', role: 'status' }), store = h('p', { class: 'sub small' });
      (async () => {
        try {
          const p = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
          const e = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
          store.textContent = '保存の状態: ' + (p === true ? '消されにくい設定になっています' : p === false ? '端末の判断で消されることがあります(バックアップをおすすめします)' : '確認できませんでした') + (e && e.usage ? '。使用量 約 ' + Math.max(1, Math.round(e.usage / 1024 / 1024)) + ' MB' : '');
        } catch (x) { store.textContent = '保存の状態を確認できませんでした。'; }
      })();
      body.append(
        h('div', { class: 'card' }, h('h2', { text: '見た目' }), h('div', { class: 'seg', role: 'group', 'aria-label': '表示の色' }, [['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']].map((o) => h('button', { 'aria-pressed': String(theme === o[0]), text: o[1], onclick: () => { try { localStorage.setItem('bl-theme', o[0]); } catch (e) { /* 保存できなくても今回は反映 */ } applyTheme(); page.refresh(); renderView(); } })))),
        h('div', { class: 'card' }, h('h2', { text: '開始時の体重(kg)' }), sw, msg,
          h('button', { class: 'btn', style: { marginTop: '8px' }, text: '保存', onclick: async () => { const v = parseNum(sw.value); if (v === undefined || (v !== null && (v < 20 || v > 300))) { msg.textContent = '20〜300の数字で入れてください。'; return; } await setSetting('startWeight', v); msg.textContent = '保存しました。'; renderView(); } })),
        h('div', { class: 'card' }, h('h2', { text: '30日チャレンジ' }), h('button', { class: 'btn', text: '開始日・日数を変える', onclick: openChallengeSetup })),
        goalsCard(),
        h('div', { class: 'card' }, h('h2', { text: 'この端末のデータ' }), store,
          h('p', { class: 'sub small', text: 'データは、この端末のブラウザの中だけに保存されます。外部のサーバーには送りません(通信を禁止する設定も入れています)。' }),
          h('button', { class: 'btn danger', style: { width: '100%' }, text: 'すべてのデータを削除', onclick: async () => {
            if (!(await confirmBox('すべてのデータを削除しますか?', '削除する', true, '記録・食事・写真・メモがこの端末から消え、元に戻せません。先にバックアップの書き出しをおすすめします。'))) return;
            if (!(await confirmBox('本当に削除しますか?', '完全に削除する', true))) return;
            await db.clearAll(); await load(); page.close(); refreshAll(); toast('削除しました');
          } })),
        h('div', { class: 'card' }, h('h2', { text: 'このアプリについて' }), h('p', { class: 'small', style: { margin: 0 }, text: 'からだログ(仮称) バージョン ' + VERSION + '。体重・体組成と食事を、自分のために記録するアプリです。医療の診断・治療の代わりではありません。数字や体調で気になることは、医師などに相談してください。' })));
    }, { static: true });
  }

  // ---------- もっと・全体 ----------
  function viewMore(c) {
    const item = (t, s, fn) => h('button', { class: 'item', onclick: fn }, h('div', { class: 'grow' }, h('div', { style: { fontWeight: '600' }, text: t }), h('div', { class: 'sub small', text: s })), h('span', { class: 'sub', text: '›', 'aria-hidden': 'true' }));
    c.append(h('h1', { text: 'もっと' }), h('div', { class: 'card' }, h('div', { class: 'list' },
      item('健康診断・受診メモ', '結果や次回の予定(常に自分だけ)', openHealthPage),
      item('進捗写真', '日付つきで並べて比較(端末内のみ)', openProgressPage),
      item('データ', '取り込み・書き出し・バックアップ', openDataPage),
      item('設定', '見た目・開始時の体重・チャレンジ', openSettings))),
      h('p', { class: 'foot', text: 'からだログ(仮称) v' + VERSION + ' / 医療の診断・治療の代わりではありません。' }));
  }
  const TABS = [['home', '⌂', 'ホーム', viewHome], ['log', '☷', 'きろく', viewLog], ['graph', '↗', 'グラフ', viewGraph], ['meals', '◎', '食事', viewMeals], ['more', '⋯', 'もっと', viewMore]];
  function renderTabs() {
    $('#tabs').replaceChildren(...TABS.map((t) => h('button', { class: 'tab', 'data-tab': t[0], 'aria-current': UI.tab === t[0] ? 'page' : null, onclick: () => { UI.tab = t[0]; renderTabs(); renderView(); window.scrollTo(0, 0); } }, h('span', { class: 'ic', 'aria-hidden': 'true', text: t[1] }), h('span', { text: t[2] }))));
  }
  function renderView() {
    const v = $('#view'), t = TABS.find((x) => x[0] === UI.tab);
    const y = window.scrollY; v.replaceChildren(); v.dataset.view = UI.tab; t[3](v); window.scrollTo(0, y);
  }
  window.BLApp = { refresh: () => { renderView(); } };

  async function init() {
    applyTheme();
    try { await load(); } catch (e) {
      $('#view').append(h('div', { class: 'card' }, h('h1', { text: '保存の準備ができませんでした' }), h('p', { text: 'このブラウザでは、端末内の保存が使えないようです(プライベートブラウズなど)。通常のSafariで開き直してください。' }))); return;
    }
    renderTabs(); renderView();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン用。なくても動く */ });
  }
  init();
})();
