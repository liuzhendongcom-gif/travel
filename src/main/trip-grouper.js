/**
 * 行程分组算法 v3
 *
 * 核心原则：
 * - 差旅申请单（apply）定义一次完整出差的基本信息（目的地、出发日期、事由）
 * - 实际机票/火车票/酒店补全时间范围：去程票的 date 是出发日，
 *   返程票的 date 或酒店的 check_out 是结束日
 * - 同一趟出差（申请单 → 去程票 → 酒店 → 回程票）合并为 1 个行程段
 * - 无申请单时退回锚点模式：把相邻 flight/train 之间的票归在一起
 *
 * 分组逻辑：
 * 1. 有 apply 记录：每张申请单创建一个行程段，时间窗口 = [apply.date, apply.date + 30天]
 *    - 在窗口内的机票/火车/酒店/打车/餐饮归入
 *    - 若同一目的地有多张申请单取最新一张
 * 2. 无 apply 记录：以 flight/train 为锚点，相同城市对（A→B, B→A）的去返程合并为一段
 * 3. 最终按行程 startDate 升序返回
 */

const { getFullConfig } = require('./token-store');

function groupByTrip(records) {
  const applies = records.filter(r => r.type === 'apply');

  if (applies.length > 0) {
    return groupByApply(records, applies);
  }
  return groupByAnchor(records);
}

// ── 模式1：以申请单为骨架 ──────────────────────────
function groupByApply(records, applies) {
  // 去重申请单（同 from+to+date 只保留一张）
  const seen = new Set();
  const uniqueApplies = applies.filter(a => {
    const key = `${a.from||''}|${a.to||''}|${a.date||''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const trips = uniqueApplies.map((apply, idx) => {
    // 窗口结束 = 下一张申请单的前一天（或 +60 天兜底），最少覆盖到当天
    const nextApply = uniqueApplies[idx + 1];
    const rawEnd = nextApply?.date
      ? addDays(nextApply.date, -1)
      : (apply.date ? addDays(apply.date, 60) : '9999-12-31');
    // 防止窗口倒置（两张申请单同一天时 rawEnd < apply.date）
    const windowEnd = apply.date && rawEnd < apply.date ? addDays(apply.date, 30) : rawEnd;
    return {
      id: idx + 1,
      applyDate: apply.date || '',
      applyWindowEnd: windowEnd,   // 申请单定义的原始窗口上限，用于限制天数
      from: apply.from || '',
      to: apply.to || '',
      name: buildTripName(apply),
      records: [apply],
      _windowStart: apply.date || '',
      _windowEnd: windowEnd,
    };
  });

  // 非申请单记录：严格按窗口归入，窗口外的收集为未匹配
  const unmatched = [];
  const others = records.filter(r => r.type !== 'apply');

  for (const rec of others) {
    const trip = findBestApplyTrip(trips, rec);
    if (trip) trip.records.push(rec);
    else unmatched.push(rec);
  }

  // 收紧每个行程的实际结束日期（不超过申请单窗口上限）
  for (const trip of trips) {
    updateTripWindow(trip);
    trip.records.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  }

  const result = trips.filter(t => t.records.length > 0);

  // 未匹配票据单独打包
  if (unmatched.length > 0) {
    unmatched.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    result.push({
      id: result.length + 1,
      name: '未匹配票据',
      from: '', to: '',
      _unmatched: true,
      records: unmatched,
    });
  }

  return result;
}

// 严格窗口匹配：只归入日期在窗口内的票据，窗口外返回 null
function findBestApplyTrip(trips, rec) {
  const recDate = rec.date || rec.check_in || '';

  // 无日期票据：无法判断归属，归入未匹配
  if (!recDate) return null;

  // 候选：日期在窗口内
  const candidates = trips.filter(t =>
    t._windowStart <= recDate && recDate <= t._windowEnd
  );

  if (candidates.length === 0) return null; // 不在任何窗口内 → 未匹配

  if (candidates.length === 1) return candidates[0];

  // 多个窗口重叠：优先城市匹配，再取窗口起始最近的
  const cityMatch = candidates.find(t =>
    (rec.to && t.to && normalize(rec.to) === normalize(t.to)) ||
    (rec.from && t.to && normalize(rec.from) === normalize(t.to)) ||
    (rec.to && t.from && normalize(rec.to) === normalize(t.from))
  );
  if (cityMatch) return cityMatch;

  return candidates.reduce((best, t) =>
    Math.abs(dayDiff(t._windowStart, recDate)) < Math.abs(dayDiff(best._windowStart, recDate)) ? t : best
  );
}

function updateTripWindow(trip) {
  // 收紧窗口为票据实际日期范围，但不超过申请单定义的窗口上限
  const allDates = trip.records
    .flatMap(r => [r.date, r.check_in, r.check_out])
    .filter(Boolean)
    .sort();
  if (allDates.length === 0) return;
  if (allDates[0] < trip._windowStart) trip._windowStart = allDates[0];
  const latestDate = allDates[allDates.length - 1];
  const cap = trip.applyWindowEnd || trip._windowEnd;
  trip._windowEnd = latestDate < cap ? latestDate : cap;
}

// ── 模式2：无申请单，以 flight/train 为锚点 ─────────
function groupByAnchor(records) {
  const anchors = records
    .filter(r => ['flight', 'train'].includes(r.type) && r.from && r.to)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  if (anchors.length === 0) {
    const sorted = [...records].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const name = sorted[0]?.date ? `出差_${sorted[0].date}` : '全部票据';
    return [{ id: 1, name, from: '', to: '', records: sorted }];
  }

  // 把去程和返程合并：若 A→B 后有 B→A 则归一段
  const groups = [];
  const usedIdx = new Set();

  for (let i = 0; i < anchors.length; i++) {
    if (usedIdx.has(i)) continue;
    const outbound = anchors[i];
    // 找返程：from=outbound.to, to=outbound.from，且日期 >= outbound.date
    let returnIdx = -1;
    for (let j = i + 1; j < anchors.length; j++) {
      if (usedIdx.has(j)) continue;
      const r = anchors[j];
      if (
        r.from && r.to &&
        normalize(r.from) === normalize(outbound.to) &&
        normalize(r.to) === normalize(outbound.from)
      ) { returnIdx = j; break; }
    }

    const groupAnchors = [outbound];
    if (returnIdx !== -1) {
      groupAnchors.push(anchors[returnIdx]);
      usedIdx.add(returnIdx);
    }
    usedIdx.add(i);

    const tripStart = outbound.date || '';
    const tripEnd   = returnIdx !== -1 ? (anchors[returnIdx].date || tripStart) : tripStart;

    groups.push({
      id: groups.length + 1,
      name: buildTripName(outbound),
      from: outbound.from,
      to: outbound.to,
      _windowStart: tripStart,
      _windowEnd: tripEnd ? addDays(tripEnd, 1) : addDays(tripStart, 30),
      records: groupAnchors,
    });
  }

  // 非锚点票据归入时间最近的行程段
  const nonAnchors = records.filter(r => !anchors.includes(r));
  for (const rec of nonAnchors) {
    const trip = findBestApplyTrip(groups, rec);
    if (trip) trip.records.push(rec);
    else groups[0]?.records.push(rec);
  }

  for (const trip of groups) {
    trip.records.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  }

  return groups;
}

// ── 工具函数 ───────────────────────────────────────
function normalize(city) {
  return (city || '')
    .replace(/市$/, '')       // 去掉中文"市"后缀
    .replace(/\s*city$/i, '') // 去掉英文 City 后缀
    .toLowerCase()
    .trim();
}

function addDays(dateStr, n) {
  if (!dateStr) return '9999-12-31';
  const d = new Date(dateStr);
  // M3：无效日期（AI 识别错误时可能出现）直接返回安全兜底值，避免 toISOString() 抛异常
  if (isNaN(d.getTime())) return '9999-12-31';
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayDiff(d1, d2) {
  if (!d1 || !d2) return 9999;
  const t1 = new Date(d1).getTime();
  const t2 = new Date(d2).getTime();
  // M3：任一日期无效时返回 9999（视为窗口外，归入未匹配）
  if (isNaN(t1) || isNaN(t2)) return 9999;
  return (t2 - t1) / 86400000;
}

function buildTripName(record) {
  const from = record.from || '';
  const to   = record.to   || '';
  const date = record.date || '';
  let name;
  if (from && to) name = `${from}-${to}`;
  else if (to)    name = `出差_${to}`;
  else if (from)  name = `出差_${from}`;
  else            name = '出差';
  return `${name}${date ? '_' + date : ''}`;
}

// ── 行程摘要（供卡片展示 + 复制） ───────────────────
function buildTripSummary(trip) {
  const records = trip.records;

  // 起止日期：最早 date/check_in 和最晚 date/check_out
  const startDates = records.flatMap(r => [r.date, r.check_in]).filter(Boolean).sort();
  const endDates   = records.flatMap(r => [r.date, r.check_out]).filter(Boolean).sort();
  const startDate  = startDates[0] || null;
  let   endDate    = endDates[endDates.length - 1] || null;

  // 时间上限：不超过申请单定义的窗口上限（防止被不相关票据拉长）
  if (endDate && trip.applyWindowEnd && endDate > trip.applyWindowEnd) {
    endDate = trip.applyWindowEnd;
  }

  // 总天数（半天精度）
  let durationDays = null;
  if (startDate && endDate) {
    const days = (new Date(endDate) - new Date(startDate)) / 86400000;
    durationDays = days < 1 ? 1 : Math.round(days * 2) / 2;
  }

  // 出发地/目的地（申请单 > 机票 > trip 属性）
  const apply  = records.find(r => r.type === 'apply');
  const anchor = records.find(r => ['flight', 'train'].includes(r.type) && r.from && r.to);
  const fromCity = apply?.from || anchor?.from || trip.from || null;
  const toCity   = apply?.to   || anchor?.to   || trip.to   || null;

  // 事由：优先用 apply.purpose（AI 专门提取的字段），退回 description 去前缀
  const purpose = apply
    ? (apply.purpose || '').trim() ||
      (apply.description || '').replace(/^差旅申请单[:：]?[^\s]*\s*/,'').replace(/^出差事由[:：]?\s*/,'').trim() ||
      null
    : null;

  // 各类票据
  const flights = records.filter(r => r.type === 'flight');
  const trains  = records.filter(r => r.type === 'train');
  const hotels  = records.filter(r => r.type === 'hotel');
  const taxis   = records.filter(r => r.type === 'taxi');
  const meals   = records.filter(r => r.type === 'meal');
  const others  = records.filter(r => !['flight','train','hotel','taxi','meal','apply'].includes(r.type));

  // 详细清单（供复制）
  const details = [];
  for (const f of flights) {
    details.push({ category: 'flight',
      label: `机票：${f.from||''}→${f.to||''} ${f.date||''} ${f.description||''}`.replace(/\s+/g,' ').trim() });
  }
  for (const t of trains) {
    details.push({ category: 'train',
      label: `火车：${t.from||''}→${t.to||''} ${t.date||''} ${t.description||''}`.replace(/\s+/g,' ').trim() });
  }
  for (const h of hotels) {
    const nights = (h.check_in && h.check_out)
      ? Math.round((new Date(h.check_out) - new Date(h.check_in)) / 86400000) + '晚'
      : '';
    details.push({ category: 'hotel',
      label: `酒店：${h.hotel_name || h.description || ''} ${h.check_in||''}～${h.check_out||''} ${nights}`.replace(/\s+/g,' ').trim() });
  }
  for (const tx of taxis) {
    details.push({ category: 'taxi',
      label: `打车：${tx.date||''} ${tx.description||''} ¥${tx.amount||''}`.replace(/\s+/g,' ').trim() });
  }

  // 总金额（折合目标货币）
  const cfg = getFullConfig();
  const fxTarget = ['CNY', 'HKD'].includes(cfg.fxTarget) ? cfg.fxTarget : 'CNY';
  const totalCny = records.reduce((s, r) => {
    let converted;
    if (r.currency && r.currency !== fxTarget) {
      // 外币：优先用 AI 估算的折算值；若为 null（无法估算），用原始金额作为近似值
      converted = r.amount_cny != null ? Number(r.amount_cny) : Number(r.amount) || 0;
    } else {
      converted = Number(r.amount) || 0;
    }
    return s + converted;
  }, 0);

  const hotelNights = hotels.reduce((s, h) => {
    if (!h.check_in || !h.check_out) return s + 1;
    return s + Math.max(1, Math.round((new Date(h.check_out) - new Date(h.check_in)) / 86400000));
  }, 0);

  return {
    startDate, endDate, durationDays,
    fromCity, toCity, purpose,
    details, totalCny,
    flightCount: flights.length,
    trainCount:  trains.length,
    hotelNights,
    taxiCount:   taxis.length,
    mealCount:   meals.length,
    otherCount:  others.length,
  };
}

module.exports = { groupByTrip, buildTripSummary };
