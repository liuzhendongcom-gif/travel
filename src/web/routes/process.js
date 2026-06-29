const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const { prepareForAI } = require('../../main/file-processor');
const { recognizeReceipt } = require('../../main/ai-service');
const { groupByTrip, buildTripSummary } = require('../../main/trip-grouper');
const { buildOutput, sanitizeName } = require('../../main/output-builder');
const { getFullConfig } = require('../../main/token-store');
const { send, getRecords, setRecords, verifySession } = require('../ws-handler');

const router = Router();

// BUG-05：各格式 magic bytes（前几字节），用于校验文件实际类型
const MAGIC_BYTES = [
  { exts: ['.jpg', '.jpeg'], magic: [0xFF, 0xD8, 0xFF] },
  { exts: ['.png'],          magic: [0x89, 0x50, 0x4E, 0x47] },
  { exts: ['.gif'],          magic: [0x47, 0x49, 0x46, 0x38] },
  { exts: ['.webp'],         magic: [0x52, 0x49, 0x46, 0x46] }, // RIFF header
  { exts: ['.pdf'],          magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  // docx 是 ZIP 格式，magic: PK\x03\x04
  { exts: ['.docx'],         magic: [0x50, 0x4B, 0x03, 0x04] },
];

function checkMagicBytes(filePath, ext) {
  // txt 无固定 magic bytes，跳过校验
  if (ext === '.txt') return true;
  const rule = MAGIC_BYTES.find(r => r.exts.includes(ext));
  if (!rule) return true; // 未知扩展名，交由后续处理
  try {
    const buf = Buffer.alloc(rule.magic.length);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, rule.magic.length, 0);
    fs.closeSync(fd);
    return rule.magic.every((byte, i) => buf[i] === byte);
  } catch (_) {
    return false;
  }
}

// multer：上传到临时目录，保留原始扩展名
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `tr_upload_${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf', '.docx', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// BUG-06：per-session 互斥锁，防止并发上传覆盖识别结果
const processingSet = new Set();

// POST /api/process/files
// 接收多文件，逐个识别，进度通过 WebSocket 推送
router.post('/files', upload.array('files'), async (req, res) => {
  const sessionId = verifySession(req);
  if (!sessionId) {
    for (const f of req.files || []) { try { fs.unlinkSync(f.path); } catch (_) {} }
    return res.status(401).json({ error: '会话无效或已过期，请刷新页面重试' });
  }

  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: '未上传任何文件' });

  // BUG-06：同一 session 正在处理时拒绝新请求
  if (processingSet.has(sessionId)) {
    // 清理本次上传的临时文件
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch (_) {}
    }
    return res.status(429).json({ error: '正在识别中，请稍候' });
  }

  const cfg = getFullConfig();
  const concurrency = Math.min(5, Math.max(1, Number(cfg.concurrency) || 1));

  // fileId 由客户端在 FormData 中通过 JSON 字段传递
  let fileMeta = [];
  try { fileMeta = JSON.parse(req.body.fileMeta || '[]'); } catch (_) {}

  const fileList = files.map((f, i) => ({
    id:   fileMeta[i]?.id   || crypto.randomUUID(),
    name: fileMeta[i]?.name || f.originalname,
    path: f.path,
    ext:  path.extname(f.originalname).toLowerCase(),
  }));

  // 立即响应，识别异步进行
  res.json({ ok: true, count: fileList.length });

  processingSet.add(sessionId);
  const existingRecords = getRecords(sessionId);
  const newRecords = [];

  try {
    const queue = [...fileList];
    const inFlight = new Set();

    async function processOne(file) {
      send(sessionId, 'file-start', { fileId: file.id, name: file.name });
      try {
        // BUG-05：校验文件实际内容与扩展名一致
        if (!checkMagicBytes(file.path, file.ext)) {
          throw new Error(`文件内容与扩展名 ${file.ext} 不符，已拒绝处理`);
        }
        const prepared = await prepareForAI(file.path, { ocrEngine: 'tesseract' });
        const result = await recognizeReceipt(prepared.inputType, prepared.content);
        result._fileId   = file.id;
        result._fileName = file.name;
        result._filePath = file.path; // 服务器临时路径，用于生成报销包时复制
        newRecords.push(result);
        send(sessionId, 'file-done', { fileId: file.id, result });
      } catch (err) {
        send(sessionId, 'file-error', { fileId: file.id, error: err.message });
      } finally {
        // 识别后不立即删除临时文件，export 时还需要复制原件
        await new Promise(r => setTimeout(r, 300));
      }
    }

    while (queue.length > 0 || inFlight.size > 0) {
      while (queue.length > 0 && inFlight.size < concurrency) {
        const file = queue.shift();
        const task = processOne(file).finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
      if (inFlight.size > 0) await Promise.race(inFlight);
    }

    setRecords(sessionId, [...existingRecords, ...newRecords]);
  } finally {
    processingSet.delete(sessionId);
  }
});

// POST /api/process/export
router.post('/export', async (req, res) => {
  const sessionId = verifySession(req);
  if (!sessionId) return res.status(401).json({ error: '会话无效或已过期，请刷新页面重试' });

  const records = getRecords(sessionId);
  if (records.length === 0) return res.status(400).json({ error: '没有已识别的票据' });

  send(sessionId, 'toast', { message: '正在按行程分组...' });
  const trips = groupByTrip(records);

  send(sessionId, 'toast', { message: `分为 ${trips.length} 个行程，正在生成文件...` });

  const downloadId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const outputDir  = path.join(os.tmpdir(), `tr_export_${downloadId}`);
  const zipPath    = path.join(os.tmpdir(), `tr_export_${downloadId}.zip`);

  // 清理临时上传文件的辅助函数（成功和失败路径均需调用）
  function cleanupUploads() {
    for (const r of records) {
      if (r._filePath && r._filePath.includes(os.tmpdir())) {
        try { fs.unlinkSync(r._filePath); } catch (_) {}
      }
    }
  }

  try {
    await buildOutput(trips, outputDir, zipPath);

    const tripCards = trips.map(trip => ({
      id:        trip.id,
      name:      trip.name,
      unmatched: trip._unmatched || false,
      ...buildTripSummary(trip),
    }));

    // BUG-13：清理临时上传文件（成功路径）
    cleanupUploads();

    res.json({ ok: true, downloadId, tripCount: trips.length, tripCards });
  } catch (e) {
    // BUG-13：清理临时上传文件（失败路径，原来缺失）
    cleanupUploads();
    res.status(500).json({ error: e.message });
  }
});

// POST /api/process/clear  — 清空会话记录
router.post('/clear', (req, res) => {
  const sessionId = verifySession(req);
  if (sessionId) {
    const records = getRecords(sessionId);
    for (const r of records) {
      if (r._filePath && r._filePath.includes(os.tmpdir())) {
        try { fs.unlinkSync(r._filePath); } catch (_) {}
      }
    }
    setRecords(sessionId, []);
  }
  res.json({ ok: true });
});

module.exports = router;
