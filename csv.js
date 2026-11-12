// CSVの読み書き。ブラウザでは window.BL.csv、node では module.exports
(function (root) {
  'use strict';
  const HEADER = ['date', 'timing', 'weight_kg', 'body_fat_pct', 'skeletal_muscle_pct', 'water_pct', 'bone_kg', 'bmr_kcal', 'bmi', 'note', 'flags'];
  const MAP = { weight_kg: 'weight', body_fat_pct: 'fat', skeletal_muscle_pct: 'muscle', water_pct: 'water', bone_kg: 'bone', bmr_kcal: 'bmr', bmi: 'bmi' };
  const RANGE = { weight: [20, 300], fat: [1, 70], muscle: [5, 90], water: [10, 90], bone: [0.3, 15], bmr: [300, 5000], bmi: [8, 80] };

  function isRealKey(k) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
    const p = k.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]);
    return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
  }

  // RFC4180風。引用符・改行入りセルに対応。先頭のBOMは外す
  function parse(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = ''; rows.push(row); row = [];
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function unguard(s) { return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s; }
  function guard(s) { return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }

  // 取り込み。{records, startWeight, skipped:[{line,reason}], notes:[]} / 形式が違えば {error}
  function importCsv(text) {
    const rows = parse(text).filter((r) => r.some((c) => c.trim() !== ''));
    if (!rows.length) return { error: 'ファイルが空です。' };
    // 別の列名(body_water_pct / bone_mass_kg)にも対応
    const ALIAS = { body_water_pct: 'water_pct', bone_mass_kg: 'bone_kg' };
    const head = rows[0].map((h) => { const x = h.trim().toLowerCase(); return ALIAS[x] || x; });
    const col = {}; head.forEach((h, i) => { col[h] = i; });
    if (col.date === undefined || col.weight_kg === undefined) return { error: '1行目に date と weight_kg の列が必要です。' };
    const get = (r, name) => (col[name] === undefined || r[col[name]] === undefined ? '' : r[col[name]].trim());
    const out = { records: [], startWeight: null, skipped: [], notes: [] };
    let badNum = 0;
    rows.slice(1).forEach((r, idx) => {
      const line = idx + 2;
      const flagList = get(r, 'flags').split('|').map((s) => s.trim()).filter(Boolean);
      const date = get(r, 'date');
      const yes = (name) => get(r, name).toLowerCase() === 'true', no = (name) => get(r, name).toLowerCase() === 'false';
      if (yes('is_reference_only')) flagList.push('reference');
      if (yes('date_estimated')) flagList.push('estimated_date');
      if (no('measured')) flagList.push('no_measurement');
      if (date === '' && /開始時|ベースライン/.test(get(r, 'label') + get(r, 'note'))) flagList.push('baseline');
      if (flagList.includes('baseline')) {
        const w = Number(get(r, 'weight_kg'));
        if (isFinite(w) && w > 0) out.startWeight = w; else out.skipped.push({ line, reason: '開始時の体重が読めません' });
        return;
      }
      if (!isRealKey(date)) { out.skipped.push({ line, reason: '日付が YYYY-MM-DD の形ではありません' }); return; }
      const timing = get(r, 'timing'); const rec = { date, timing: timing === '-' ? '' : unguard(timing), note: unguard(get(r, 'note')), flags: {}, source: 'csv' };
      if (flagList.includes('reference')) rec.flags.reference = true;
      if (flagList.includes('estimated_date')) rec.flags.estimated = true;
      if (flagList.includes('no_measurement')) rec.flags.none = true;
      Object.keys(MAP).forEach((name) => {
        const f = MAP[name], s = get(r, name);
        if (s === '') { rec[f] = null; return; }
        const v = Number(s.replace(/,/g, ''));
        if (!isFinite(v) || v < RANGE[f][0] || v > RANGE[f][1]) { rec[f] = null; badNum++; } else rec[f] = v;
      });
      out.records.push(rec);
    });
    if (badNum) out.notes.push('数字として読めない・範囲外の値が ' + badNum + ' か所あり、空欄として取り込みました。');
    return out;
  }

  function flagsOf(r) {
    const f = [];
    if (r.flags && r.flags.reference) f.push('reference');
    if (r.flags && r.flags.estimated) f.push('estimated_date');
    if (r.flags && r.flags.none) f.push('no_measurement');
    return f.join('|');
  }
  function esc(s) {
    s = String(s == null ? '' : s);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(records, startWeight) {
    const lines = [HEADER.join(',')];
    if (typeof startWeight === 'number') lines.push(',,' + startWeight + ',,,,,,,開始時の体重,baseline');
    const sorted = records.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
    sorted.forEach((r) => {
      lines.push([r.date, esc(guard(r.timing || '')), r.weight, r.fat, r.muscle, r.water, r.bone, r.bmr, r.bmi, esc(guard(r.note || '')), flagsOf(r)]
        .map((x) => (x == null ? '' : x)).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }
  function dedupKey(r) {
    return [r.date, r.timing || '', r.weight, r.fat, r.muscle, r.water, r.bone, r.bmr, r.bmi, r.note || '', flagsOf(r)].join('\u0001');
  }

  const api = { parse, importCsv, toCsv, dedupKey, HEADER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.BL = root.BL || {}; root.BL.csv = api; }
})(typeof window !== 'undefined' ? window : globalThis);
