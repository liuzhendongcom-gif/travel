const Anthropic = require('@anthropic-ai/sdk');

const { getFullConfig, DEFAULT_MODEL } = require('./token-store');
const { truncateForAI } = require('./security');

function getClient() {
  const cfg = getFullConfig();
  const apiKey = cfg.token || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('未配置 API Key，请点击右上角齿轮进行设置');
  return new Anthropic({
    apiKey,
    baseURL: cfg.baseUrl,
  });
}

const SYSTEM_PROMPT = `你是差旅报销票据识别助手，支持中文、英文及繁体中文票据。严格只返回一个 JSON 对象，禁止使用 markdown 代码块，禁止任何解释文字。`;

const USER_PROMPT = `从以下票据内容中提取报销信息，严格按此 JSON 格式返回（字段不够用 null，禁止增减字段，禁止嵌套）：
{
  "type": "flight|train|hotel|taxi|meal|apply|other",
  "date": "YYYY-MM-DD",
  "amount": 0.00,
  "currency": "CNY|HKD|USD|EUR|其他ISO代码",
  "amount_cny": 0.00,
  "from": "出发城市（中文）",
  "to": "目的城市（中文）",
  "hotel_name": "酒店名称",
  "check_in": "YYYY-MM-DD",
  "check_out": "YYYY-MM-DD",
  "purpose": "出差事由原文，仅 type=apply 时填写，其余为 null",
  "description": "一句话描述，如：深圳-上海 MU5336 / 上海大厦1晚 / 香港的士 HK$45",
  "confidence": "high|medium|low"
}

规则：
- 支持英文、繁体中文票据（香港出租车收据、餐厅小票、租车发票等）
- type 判断：taxi/cab/的士→taxi；hotel/hostel/inn/酒店/宾馆→hotel；restaurant/dining/餐→meal；car rental/租车→other；flight/航班→flight；train/火车→train；差旅申请单→apply
- currency 填票面货币，HKD 港币、CNY 人民币，无法判断时填 null
- amount 填票面原始金额数字；amount_cny 若为外币则按当时汇率估算人民币（无法估算则填 null）
- date 填实际出行/消费日期，格式 YYYY-MM-DD，英文月份如 Jan/Feb 等需转换
- from/to 只填城市名，英文城市名转中文（Hong Kong→香港，Shenzhen→深圳）
- type=apply：date 填出差开始日期；purpose 填申请单中"出差事由"/"出行事由"/"事由"字段的原始内容（如"上海参加领导力原则培训"）；description 填"出差事由简述"
- purpose 只填事由正文，不加任何前缀，30字以内
- description 控制在 30 字以内，英文内容转中文描述

票据内容：`;

// 带指数退避的重试，处理限流(429/503)
async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err.message || '');
      const isRateLimit = err.status === 429 || err.status === 503
        || msg.includes('Too Many Requests') || msg.includes('rate_limit');

      if (isRateLimit && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 2000 + Math.random() * 1000; // 2s/4s/8s + jitter
        console.warn(`限流，${Math.round(delay / 1000)}s 后重试 (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

async function recognizeReceipt(inputType, content) {
  return withRetry(async () => {
    const client = getClient();
    const cfg = getFullConfig();
    const safeContent = truncateForAI(content);
    const response = await client.messages.create({
      model: cfg.model || DEFAULT_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${USER_PROMPT}\n${safeContent}` }],
    });

    const raw = response.content[0].text.trim();

    // 提取 JSON（兼容 AI 偶尔包裹 markdown 代码块）
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI 返回格式异常: ' + raw.slice(0, 120));

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      // 尝试截取到最后一个完整字段修复
      const fixedMatch = raw.match(/\{[\s\S]*"confidence"\s*:\s*"[^"]*"/);
      if (fixedMatch) {
        try { parsed = JSON.parse(fixedMatch[0] + '}'); } catch (_) {}
      }
      if (!parsed) throw new Error('JSON 解析失败: ' + e.message);
    }

    for (const key of Object.keys(parsed)) {
      if (typeof parsed[key] === 'string' && parsed[key].length > 500) {
        parsed[key] = parsed[key].slice(0, 500);
      }
    }

    return parsed;
  });
}

module.exports = { recognizeReceipt };
