const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const router = Router();

// 下载报销包 ZIP
router.get('/:id', (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, ''); // 安全过滤
  const zipPath = path.join(os.tmpdir(), `tr_export_${id}.zip`);

  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: '文件不存在或已过期' });
  }

  const stat = fs.statSync(zipPath);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''%E5%B7%AE%E6%97%85%E6%8A%A5%E9%94%80_${id}.zip`);
  res.setHeader('Content-Length', stat.size);

  const stream = fs.createReadStream(zipPath);
  stream.pipe(res);
  // M6：监听 res 的 finish 事件（数据完整写出）而非 stream 的 close（网络断开也会触发）
  res.on('finish', () => {
    setTimeout(() => {
      try { fs.unlinkSync(zipPath); } catch (_) {}
    }, 5000);
  });
});

module.exports = router;
