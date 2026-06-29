/**
 * 外币汇率查询
 *
 * 策略：
 * - 汇率数值：api.frankfurter.app（欧洲央行，支持历史，无需 API Key）
 * - 截图功能已移除（减小安装包体积），txt 中提供中行官网链接供人工核对
 */

const https = require('https');
const http = require('http');

const CURRENCY_NAME = {
  HKD: '港元', USD: '美元', EUR: '欧元', JPY: '日元',
  GBP: '英镑', AUD: '澳元', CAD: '加元', SGD: '新加坡元',
  CHF: '瑞郎', THB: '泰铢', KRW: '韩元', MYR: '林吉特',
  TWD: '新台币', SEK: '瑞典克朗', NOK: '挪威克朗',
  DKK: '丹麦克朗', NZD: '新西兰元',
};

const BOC_RATE_URL = 'https://www.boc.cn/sourcedb/whpj/';

function isToday(dateStr) {
  return dateStr === new Date().toISOString().slice(0, 10);
}

function fetchJson(url, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('重定向次数过多'));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 12000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) return reject(new Error('重定向缺少 Location 头'));
        return fetchJson(location, depth + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON解析失败: ' + data.slice(0, 80))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

async function getHistoricalRate(currency, dateStr, targetCurrency = 'CNY') {
  const target = targetCurrency.toUpperCase();
  if (!currency || currency.toUpperCase() === target) return { rate: 1, actualDate: dateStr };
  const cur = currency.toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  if (!/^[A-Z]{3}$/.test(cur) || !/^[A-Z]{3}$/.test(target)) return null;
  try {
    const url = `https://api.frankfurter.app/${dateStr}?from=${cur}&to=${target}`;
    const data = await fetchJson(url);
    if (data.rates && data.rates[target]) {
      return { rate: Number(data.rates[target]), actualDate: data.date || dateStr };
    }
    return null;
  } catch (e) {
    console.warn(`[汇率] 查询失败 ${currency} → ${target} ${dateStr}: ${e.message}`);
    return null;
  }
}

async function screenshotBocRateTable() {
  return null;
}

module.exports = {
  getHistoricalRate,
  screenshotBocRateTable,
  CURRENCY_NAME,
  isToday,
  BOC_RATE_URL,
};
