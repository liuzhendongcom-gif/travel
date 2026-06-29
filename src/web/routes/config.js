const { Router } = require('express');
const { getFullConfig, saveFullConfig } = require('../../main/token-store');
const { maskToken, resolveTokenInput, validateToken } = require('../../main/security');

const router = Router();

router.get('/settings', (req, res) => {
  const cfg = getFullConfig();
  res.json({ ...cfg, token: maskToken(cfg.token), hasToken: Boolean(cfg.token) });
});

router.post('/settings', (req, res) => {
  try {
    const cfg = req.body;
    const existing = getFullConfig();

    // M1：token 验证：含 *** 为掩码（保留原值）；否则必须 ≥8 字符
    let token = existing.token;
    const rawToken = String(cfg.token || '').trim();
    if (rawToken && !rawToken.includes('***')) {
      token = validateToken(rawToken); // 长度/格式校验，不合法会抛异常
    }

    const config = {
      token,
      model:       String(cfg.model || existing.model || '').trim(),
      baseUrl:     String(cfg.baseUrl || existing.baseUrl || '').trim(),
      concurrency: cfg.concurrency != null ? Number(cfg.concurrency) : existing.concurrency,
      ocrEngine:   'tesseract', // M2：web 版固定 tesseract，不再用三元表达式假装可配置
      debugLog:    cfg.debugLog !== false,
      dedupCheck:  cfg.dedupCheck !== false,
      fxTarget:    ['CNY', 'HKD'].includes(cfg.fxTarget) ? cfg.fxTarget : 'CNY',
    };
    saveFullConfig(config);
    if (config.token) process.env.ANTHROPIC_API_KEY = config.token;
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
