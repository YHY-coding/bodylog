// 計算(画面に依存しない)。ブラウザでは window.BL.calc、node では module.exports
(function (root) {
  'use strict';
  const pad = (n) => String(n).padStart(2, '0');
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const FIELDS = ['weight', 'fat', 'muscle', 'water', 'bone', 'bmr', 'bmi'];

  function keyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseKey(k) { const p = k.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(k, n) { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); }
  function diffDays(a, b) {
    const x = parseKey(a), y = parseKey(b);
    return Math.round((Date.UTC(y.getFullYear(), y.getMonth(), y.getDate()) - Date.UTC(x.getFullYear(), x.getMonth(), x.getDate())) / 864e5);
  }
  function mondayOf(k) { return addDays(k, -((parseKey(k).getDay() + 6) % 7)); }
  function labelOf(k, withYear) {
    const d = parseKey(k);
    return (withYear ? d.getFullYear() + '/' : '') + (d.getMonth() + 1) + '/' + d.getDate() + '(' + WD[d.getDay()] + ')';
  }
  function isRealKey(k) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
    const d = parseKey(k); return keyOf(d) === k;
  }

  // 平均に入る値か: 測定なし・参考値は入らない。日付推定は入る
  function usable(r, f) {
    return !!(r && r.date && !(r.flags && (r.flags.reference || r.flags.none)) && typeof r[f] === 'number' && isFinite(r[f]));
  }
  function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

  // 日付 -> その日の値(同じ日に複数あれば平均)
  function dailyValues(records, f) {
    const acc = {};
    records.forEach((r) => { if (usable(r, f)) (acc[r.date] = acc[r.date] || []).push(r[f]); });
    const out = {};
    Object.keys(acc).forEach((k) => { out[k] = mean(acc[k]); });
    return out;
  }
  // 7日移動平均: その日を含む直近 win 日の「日の値」の平均。値が1つもない日は出さない
  function movingAvg(daily, win) {
    win = win || 7;
    const keys = Object.keys(daily).sort();
    if (!keys.length) return [];
    const out = [];
    for (let k = keys[0]; k <= keys[keys.length - 1]; k = addDays(k, 1)) {
      const v = [];
      for (let i = 0; i < win; i++) { const x = daily[addDays(k, -i)]; if (x !== undefined) v.push(x); }
      if (v.length) out.push({ date: k, avg: mean(v) });
    }
    return out;
  }
  function rangeAvg(daily, from, to) {
    const v = Object.keys(daily).filter((k) => k >= from && k <= to).map((k) => daily[k]);
    return v.length ? { avg: mean(v), n: v.length } : null;
  }
  function monthStart(k) { return k.slice(0, 8) + '01'; }
  function prevMonthRange(k) {
    const d = parseKey(k); d.setDate(1); d.setDate(0); // 前月末
    const end = keyOf(d); return [monthStart(end), end];
  }

  // 1項目ぶんの集計
  function periodStats(records, f, today) {
    const daily = dailyValues(records, f);
    const mon = mondayOf(today);
    const pm = prevMonthRange(today);
    const keys = Object.keys(daily).sort();
    let min = null, max = null, latest = null;
    records.forEach((r) => {
      if (!usable(r, f)) return;
      if (!min || r[f] < min.v) min = { v: r[f], date: r.date };
      if (!max || r[f] > max.v) max = { v: r[f], date: r.date };
    });
    if (keys.length) latest = { v: daily[keys[keys.length - 1]], date: keys[keys.length - 1] };
    return {
      thisWeek: rangeAvg(daily, mon, addDays(mon, 6)),
      lastWeek: rangeAvg(daily, addDays(mon, -7), addDays(mon, -1)),
      last7: rangeAvg(daily, addDays(today, -6), today),
      prev7: rangeAvg(daily, addDays(today, -13), addDays(today, -7)),
      thisMonth: rangeAvg(daily, monthStart(today), today),
      prevMonth: rangeAvg(daily, pm[0], pm[1]),
      min, max, latest, todayValue: daily[today] !== undefined ? daily[today] : null, count: keys.length,
    };
  }

  // 開始時からの増減(直近7日平均が無ければ最新の値で比べる)
  function changeFromStart(records, settings, today) {
    const st = periodStats(records, 'weight', today);
    let start = null, source = null;
    if (typeof settings.startWeight === 'number') { start = settings.startWeight; source = 'setting'; }
    else {
      const first = Object.keys(dailyValues(records, 'weight')).sort()[0];
      if (first) { start = dailyValues(records, 'weight')[first]; source = 'first'; }
    }
    const cur = st.last7 ? st.last7.avg : (st.latest ? st.latest.v : null);
    if (start === null || cur === null) return null;
    return { start, current: cur, diff: Math.round((cur - start) * 10) / 10, source, basis: st.last7 ? 'last7' : 'latest' };
  }

  function dayChecked(days, k) {
    const e = days[k];
    return !!(e && e.exercise && Object.keys(e.exercise).some((x) => e.exercise[x]));
  }
  // 30日チャレンジ。○日目 = 開始日からの日数+1
  function challenge(settings, days, today) {
    const start = settings.challengeStart;
    if (!start || !isRealKey(start)) return { state: 'none' };
    const total = settings.challengeDays || 30;
    const end = addDays(start, total - 1);
    if (today < start) return { state: 'before', start, end, total, daysUntil: diffDays(today, start) };
    const dayNo = diffDays(start, today) + 1;
    const last = today < end ? today : end;
    let cur = last;
    if (cur === today && !dayChecked(days, today)) cur = addDays(today, -1);
    let streak = 0;
    while (cur >= start && dayChecked(days, cur)) { streak++; cur = addDays(cur, -1); }
    let done = 0;
    const cells = [];
    for (let i = 0; i < total; i++) {
      const d = addDays(start, i), chk = dayChecked(days, d);
      if (d <= last && chk) done++;
      cells.push({ date: d, checked: chk, future: d > today, today: d === today });
    }
    return {
      state: dayNo > total ? 'finished' : 'active', start, end, total,
      dayNo: Math.min(dayNo, total), remaining: Math.max(0, total - dayNo),
      streak, done, todayChecked: dayChecked(days, today), cells,
    };
  }

  const api = { keyOf, parseKey, addDays, diffDays, mondayOf, labelOf, isRealKey, usable, dailyValues, movingAvg, rangeAvg, periodStats, changeFromStart, challenge, dayChecked, mean, FIELDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.BL = root.BL || {}; root.BL.calc = api; }
})(typeof window !== 'undefined' ? window : globalThis);
