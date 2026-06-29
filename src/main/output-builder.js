const fs = require('fs');
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');
const archiver = require('archiver');
const { getHistoricalRate, CURRENCY_NAME, isToday, BOC_RATE_URL } = require('./exchange-rate');
const { getFullConfig } = require('./token-store');

const TYPE_MAP = {
  flight: '机票',
  train: '火车票',
  hotel: '酒店',
  taxi: '出租打车',
  meal: '餐饮',
  apply: '差旅申请',
  other: '其他',
};

async function buildOutput(trips, customBaseDir, customZipPath) {
  // M4：精确到毫秒，避免同一天多次导出覆写文件
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseDir = customBaseDir || path.join(os.homedir(), 'Downloads', `差旅报销_${timestamp}`);
  fs.mkdirSync(baseDir, { recursive: true });

  for (const trip of trips) {
    const tripDir = path.join(baseDir, sanitize(trip.name));
    fs.mkdirSync(tripDir, { recursive: true });

    for (const record of trip.records) {
      if (!record._filePath || !fs.existsSync(record._filePath)) continue;
      const ext = path.extname(record._fileName || '');
      const typeName = TYPE_MAP[record.type] || record.type || 'other';
      const desc = record.description ? `_${record.description}` : '';
      const newName = sanitize(`${record.date || 'nodate'}_${typeName}${desc}${ext}`);
      fs.copyFileSync(record._filePath, path.join(tripDir, newName));
    }

    const cfg = getFullConfig();
    await buildFxDoc(trip, tripDir, cfg.fxTarget || 'CNY');
  }

  buildExcel(trips, baseDir);

  const zipPath = customZipPath || `${baseDir}.zip`;
  await zipFolder(baseDir, zipPath);

  return { zipPath, folderPath: baseDir };
}

async function buildFxDoc(trip, tripDir, fxTarget = 'CNY') {
  const fxRecords = trip.records.filter(
    r => r.currency && r.currency.toUpperCase() !== fxTarget && r.amount && r.type !== 'apply'
  );
  if (fxRecords.length === 0) return;

  const targetName = fxTarget === 'HKD' ? '港币' : '人民币';

  const rateCache = new Map();
  for (const r of fxRecords) {
    const date = r.date || trip._windowStart || '';
    const cur = r.currency.toUpperCase();
    const key = `${cur}_${date}`;
    if (!rateCache.has(key)) {
      const rateResult = await getHistoricalRate(cur, date, fxTarget).catch(() => null);
      rateCache.set(key, { rateResult, date });
    }
    const cached = rateCache.get(key);
    if (cached.rateResult) {
      r.amount_cny = Math.round(Number(r.amount) * cached.rateResult.rate * 100) / 100;
    }
  }

  const byCurrency = new Map();
  for (const r of fxRecords) {
    const cur = r.currency.toUpperCase();
    const date = r.date || trip._windowStart || '';
    const key = `${cur}_${date}`;
    const cached = rateCache.get(key) || {};
    if (!byCurrency.has(cur)) byCurrency.set(cur, []);
    byCurrency.get(cur).push({ r, key, cached });
  }

  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const hasHistorical = fxRecords.some(r => !isToday(r.date || ''));
  const hasTodayFx = fxRecords.some(r => isToday(r.date || ''));
  const lines = [
    '外币换算说明',
    `生成时间：${now}`,
    `行程：${trip.name}`,
    `换算目标货币：${targetName}（${fxTarget}）`,
    '数据来源：Frankfurter/欧洲央行（与中行折算价偏差通常 <1%）',
  ];

  if (hasTodayFx || hasHistorical) {
    lines.push(`中行汇率核对：${BOC_RATE_URL}`);
  }
  if (hasHistorical) {
    lines.push('注：历史日期汇率来自欧洲央行数据库，数值可在中国银行官网核对');
  }
  lines.push('========================================', '');

  let totalTarget = 0;

  for (const [cur, items] of byCurrency) {
    const curName = CURRENCY_NAME[cur] || cur;
    const byKey = new Map();
    for (const item of items) {
      if (!byKey.has(item.key)) byKey.set(item.key, []);
      byKey.get(item.key).push(item);
    }

    for (const [, keyItems] of byKey) {
      const { rateResult, date } = keyItems[0].cached;
      const rate = rateResult?.rate;
      const actualDate = rateResult?.actualDate || date;

      lines.push(`【${curName} ${cur}】汇率日期：${date}`);
      if (rate) {
        const note = actualDate !== date ? `（${date} 为节假日，实际使用 ${actualDate} 数据）` : '';
        lines.push(`参考汇率：1 ${cur} = ${rate.toFixed(4)} ${fxTarget}${note}`);
      } else {
        lines.push('参考汇率：获取失败，请手动填写');
      }
      lines.push('');
      lines.push('换算明细：');

      let subTotal = 0;
      for (const { r } of keyItems) {
        const amt = Number(r.amount) || 0;
        const typeName = TYPE_MAP[r.type] || r.type || '';
        if (rate) {
          const converted = Math.round(amt * rate * 100) / 100;
          subTotal = Math.round((subTotal + converted) * 100) / 100;
          lines.push(`  ${r.date || date}  ${typeName.padEnd(6)}  ${cur} ${amt.toFixed(2)} × ${rate.toFixed(4)} = ${fxTarget} ${converted.toFixed(2)}`);
        } else {
          lines.push(`  ${r.date || date}  ${typeName.padEnd(6)}  ${cur} ${amt.toFixed(2)} × ? = ${fxTarget} ?（汇率未知）`);
        }
      }

      const foreignTotal = keyItems.reduce((s, { r }) => s + (Number(r.amount) || 0), 0);
      if (rate) {
        lines.push(`  小计：${cur} ${foreignTotal.toFixed(2)} → ${fxTarget} ${subTotal.toFixed(2)}`);
        totalTarget = Math.round((totalTarget + subTotal) * 100) / 100;
      } else {
        lines.push(`  小计：${cur} ${foreignTotal.toFixed(2)} → ${fxTarget} ?`);
      }
      lines.push('');
    }
  }

  lines.push('========================================');
  lines.push(`外币合计折算${targetName}：${fxTarget} ${totalTarget.toFixed(2)}`);
  lines.push(`（以上金额不含${targetName}票据）`);

  fs.writeFileSync(path.join(tripDir, '外币换算说明.txt'), lines.join('\n'), 'utf8');
}

function buildExcel(trips, baseDir) {
  const headers = ['行程', '日期', '类型', '金额', '货币', '折合人民币', '出发地', '目的地', '说明'];
  const rows = [headers];
  let totalAmount = 0;

  for (const trip of trips) {
    const dataRecords = trip.records.filter(r => r.type !== 'apply');
    if (dataRecords.length === 0) continue;

    let tripSubtotal = 0;
    for (const r of dataRecords) {
      const currency = r.currency || 'CNY';
      const amountCny = currency !== 'CNY' && r.amount_cny
        ? Number(r.amount_cny)
        : (Number(r.amount) || 0);
      rows.push([
        trip.name,
        r.date || '',
        TYPE_MAP[r.type] || r.type || '',
        r.amount || 0,
        currency,
        amountCny,
        r.from || '',
        r.to || '',
        r.description || '',
      ]);
      tripSubtotal = Math.round((tripSubtotal + amountCny) * 100) / 100;
      totalAmount = Math.round((totalAmount + amountCny) * 100) / 100;
    }

    rows.push([`${trip.name} 小计`, '', '', '', '', tripSubtotal, '', '', '']);
    rows.push([]);
  }

  rows.push(['总计', '', '', '', '', totalAmount, '', '', '']);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
    { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 36 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '差旅报销汇总');
  XLSX.writeFile(wb, path.join(baseDir, '报销汇总.xlsx'));
}

function zipFolder(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, path.basename(sourceDir));
    archive.finalize();
  });
}

function sanitize(name) {
  const result = (name || '未命名')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 100);
  return result || '未命名';
}

module.exports = { buildOutput, sanitizeName: sanitize };
