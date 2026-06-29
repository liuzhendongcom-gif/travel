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
const { getFullConfig } = require('../token-store');
const { send, getRecords, setRecords, verifySession } = require('../ws-handler');

const router = Router();

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

// C2：per-session 互斥锁，防止并发上传覆盖识别结果
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

  // C2：同一 session 正在处理时拒绝新请求
  if (processingSet.has(sessionId)) {
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
        // C1：用 .finally 替代 .then，确保 rejection 时也能清理 inFlight
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

  // H1：成功和失败路径均需清理临时上传文件
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

    cleanupUploads();
    res.json({ ok: true, downloadId, tripCount: trips.length, tripCards });
  } catch (e) {
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
