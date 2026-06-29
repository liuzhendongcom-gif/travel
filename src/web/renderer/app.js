// ── 会话标识（每次打开页面生成，用于服务端隔离） ──
const SESSION_ID = crypto.randomUUID();
// H3：服务端生成的强随机 token，WS 连接成功后由服务端下发，HTTP 请求须携带
let SESSION_TOKEN = null;

// ── WebSocket 连接 ──
const WS_URL = `ws://${location.host}?sessionId=${SESSION_ID}`;
let ws = null;
let wsReady = false;
const wsQueue = [];

function connectWs() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    // token 在 onmessage 中收到，不在 onopen 设 wsReady
    // 防止在 token 到达前就发出请求
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'session-token') {
        // H3：缓存服务端下发的 session token，后续请求携带
        SESSION_TOKEN = msg.token;
        if (!wsReady) {
          wsReady = true;
          wsQueue.forEach(fn => fn());
          wsQueue.length = 0;
        }
      } else {
        handleWsMessage(msg);
      }
    } catch (_) {}
  };
  ws.onclose = () => {
    wsReady = false;
    SESSION_TOKEN = null;
    setTimeout(connectWs, 2000); // 自动重连
  };
}
connectWs();

function whenWsReady(fn) {
  if (wsReady) fn(); else wsQueue.push(fn);
}

// ── fetch 封装 ──
async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'x-session-id': SESSION_ID,
      // H3：附加服务端下发的 session token
      ...(SESSION_TOKEN ? { 'x-session-token': SESSION_TOKEN } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

// ── 状态 ──
const files = new Map();
let stats = { ok: 0, warn: 0, err: 0, done: 0 };
let addedOrder = 0;

// ── DOM ──
const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const fileListEl    = document.getElementById('file-list');
const fileEmpty     = document.getElementById('file-empty');
const listHeader    = document.getElementById('list-header');
const listAddBtn    = document.getElementById('list-add-btn');
const btnClear      = document.getElementById('btn-clear');
const btnExport     = document.getElementById('btn-export');
const btnReprocess  = document.getElementById('btn-reprocess');
const progressNum   = document.getElementById('progress-num');
const progressDenom = document.getElementById('progress-denom');
const progressBar   = document.getElementById('progress-bar');
const cntOk         = document.getElementById('cnt-ok');
const cntWarn       = document.getElementById('cnt-warn');
const cntErr        = document.getElementById('cnt-err');
const toastEl       = document.getElementById('toast');
const sortSelect    = document.getElementById('sort-select');
const tripDrawer    = document.getElementById('trip-drawer');
const tripCards     = document.getElementById('trip-cards');
const btnCloseDrawer = document.getElementById('btn-close-drawer');
const btnSettings   = document.getElementById('btn-settings');

// ── 常量 ──
const SUPPORTED  = ['.jpg','.jpeg','.png','.webp','.pdf','.docx','.txt'];
const EXT_ICON   = { '.pdf':'📄', '.jpg':'🖼', '.jpeg':'🖼', '.png':'🖼', '.webp':'🖼', '.docx':'📝', '.txt':'📃' };
const EXT_BG     = { '.pdf':'bg-red-50', '.jpg':'bg-emerald-50', '.jpeg':'bg-emerald-50', '.png':'bg-emerald-50', '.webp':'bg-emerald-50', '.docx':'bg-blue-50' };
const TYPE_LABEL = { flight:'✈ 机票', train:'🚄 火车票', hotel:'🏨 酒店', taxi:'🚕 打车', meal:'🍽 餐饮', apply:'📋 差旅申请', other:'📎 其他' };

// ── 底部"添加"按钮 ──
document.getElementById('btn-add-file').addEventListener('click', () => fileInput.click());

// ── 拖拽上传 ──
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', e => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  addFiles([...e.dataTransfer.files]);
});
dropZone.addEventListener('click', e => {
  const inList   = fileListEl.contains(e.target);
  const inHeader = listHeader.contains(e.target);
  const inFooter = listAddBtn.contains(e.target);
  if (!inList && !inHeader && !inFooter) fileInput.click();
});
fileInput.addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });

// ── 添加文件 ──
function addFiles(list) {
  const newFiles = [];
  for (const f of list) {
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED.includes(ext)) { showToast(`跳过不支持的文件：${f.name}`); continue; }
    // 重复检测：文件名 + 大小指纹
    const fingerprint = f.name + '|' + f.size;
    const dedupEnabled = settingsDedupCheck ? settingsDedupCheck.checked : true;
    if (dedupEnabled && [...files.values()].some(x => x._fingerprint === fingerprint)) {
      showToast(`跳过重复票据：${f.name}`); continue;
    }
    const id = crypto.randomUUID();
    files.set(id, { id, name: f.name, file: f, status: 'pending', _order: addedOrder++, _fingerprint: fingerprint });
    newFiles.push(id);
  }
  if (newFiles.length) {
    dropZone.classList.remove('done');
    renderAllItems();
    syncEmpty();
    updateRing();
    btnExport.disabled = true;
    btnReprocess.classList.add('hidden');
    doProcess(newFiles);
  }
}

// ── 渲染文件项 ──
function renderItem(id) {
  const f   = files.get(id);
  const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
  const icon = EXT_ICON[ext] || '📎';
  const bg   = EXT_BG[ext]  || 'bg-zinc-50';

  const li = document.createElement('li');
  li.dataset.id = id;
  li.draggable = true;
  li.className = 'group flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-zinc-50 transition-colors cursor-grab select-none';
  li.innerHTML = `
    <span class="text-zinc-300 text-sm cursor-grab shrink-0">⠿</span>
    <div class="w-7 h-7 rounded-md ${bg} flex items-center justify-center text-sm shrink-0">${icon}</div>
    <div class="flex-1 min-w-0">
      <div class="file-name text-xs font-medium text-zinc-800 truncate" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
      <div class="file-meta text-xs text-zinc-400 truncate mt-0.5">等待识别</div>
    </div>
    <div class="file-status w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-semibold shrink-0 bg-zinc-100 text-zinc-400">–</div>
    <button class="file-delete opacity-0 group-hover:opacity-100 w-4 h-4 rounded-full bg-zinc-100 hover:bg-red-100 text-zinc-400 hover:text-red-500 flex items-center justify-center text-[9px] shrink-0 border-none cursor-pointer transition-all">✕</button>
  `;

  li.querySelector('.file-delete').addEventListener('click', e => {
    e.stopPropagation();
    const entry = files.get(id);
    if (entry && entry.status === 'processing') return;
    files.delete(id);
    li.remove();
    syncEmpty();
    updateRing();
    if (files.size === 0) {
      btnExport.disabled = true;
      btnReprocess.classList.add('hidden');
    }
  });

  li.addEventListener('dragstart', onDragStart);
  li.addEventListener('dragover',  onDragOver);
  li.addEventListener('drop',      onDrop);
  li.addEventListener('dragend',   onDragEnd);
  fileListEl.appendChild(li);
}

const TYPE_ORDER = ['flight','train','hotel','taxi','meal','apply','other'];

function renderAllItems() {
  const mode = sortSelect ? sortSelect.value : 'added';
  let entries = [...files.values()];
  if (mode === 'type') {
    entries.sort((a, b) => {
      const ai = TYPE_ORDER.indexOf(a.result?.type ?? 'other');
      const bi = TYPE_ORDER.indexOf(b.result?.type ?? 'other');
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  } else if (mode === 'date') {
    entries.sort((a, b) => {
      const ad = a.result?.date || '', bd = b.result?.date || '';
      if (!ad && !bd) return 0; if (!ad) return 1; if (!bd) return -1;
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });
  } else {
    entries.sort((a, b) => (a._order || 0) - (b._order || 0));
  }

  const existing = {};
  fileListEl.querySelectorAll('li[data-id]').forEach(li => { existing[li.dataset.id] = li; });

  const frag = document.createDocumentFragment();
  for (const f of entries) {
    if (existing[f.id]) { frag.appendChild(existing[f.id]); }
    else { renderItem(f.id); frag.appendChild(fileListEl.lastChild); }
  }
  fileListEl.innerHTML = '';
  fileListEl.appendChild(frag);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const STATUS_STYLE = {
  pending:    'bg-zinc-100 text-zinc-400',
  processing: 'bg-brand-50 text-brand-500 animate-spin-slow',
  done:       'bg-emerald-50 text-emerald-500',
  warn:       'bg-amber-50 text-amber-500',
  error:      'bg-red-50 text-red-400',
};
const STATUS_ICON = { pending:'–', processing:'↻', done:'✓', warn:'!', error:'✕' };

function setFileStatus(id, status, meta) {
  const f = files.get(id);
  if (f) f.status = status;
  const li = fileListEl.querySelector(`[data-id="${id}"]`);
  if (!li) return;
  li.querySelector('.file-meta').textContent = meta;
  const badge = li.querySelector('.file-status');
  badge.className = `file-status w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-semibold shrink-0 ${STATUS_STYLE[status] || STATUS_STYLE.pending}`;
  badge.textContent = STATUS_ICON[status] || '–';
}

// ── 拖拽排序 ──
let dragSrc = null;
function onDragStart(e) { dragSrc = this; this.classList.add('opacity-40'); e.dataTransfer.effectAllowed = 'move'; }
function onDragOver(e) {
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  fileListEl.querySelectorAll('li').forEach(el => el.classList.remove('bg-brand-50'));
  this.classList.add('bg-brand-50');
}
function onDrop(e) {
  e.stopPropagation();
  if (dragSrc === this) return;
  const all = [...fileListEl.querySelectorAll('li')];
  if (all.indexOf(dragSrc) < all.indexOf(this)) fileListEl.insertBefore(dragSrc, this.nextSibling);
  else fileListEl.insertBefore(dragSrc, this);
}
function onDragEnd() {
  this.classList.remove('opacity-40');
  fileListEl.querySelectorAll('li').forEach(el => el.classList.remove('bg-brand-50'));
}

// ── 进度条 ──
function updateRing() {
  const total = files.size;
  const done  = [...files.values()].filter(f => ['done','warn','error'].includes(f.status)).length;
  progressNum.textContent   = done;
  progressDenom.textContent = `/${total}`;
  cntOk.textContent   = stats.ok;
  cntWarn.textContent = stats.warn;
  cntErr.textContent  = stats.err;
  const pct = total === 0 ? 0 : Math.round(done / total * 100);
  progressBar.style.width = pct + '%';
  progressBar.style.background = stats.err > 0 ? '#ef4444' : stats.warn > 0 ? '#f59e0b' : '#18181b';
}

// ── 清空 ──
btnClear.addEventListener('click', () => {
  files.clear();
  fileListEl.innerHTML = '';
  stats = { ok:0, warn:0, err:0, done:0 };
  addedOrder = 0;
  syncEmpty(); updateRing();
  btnExport.textContent = '生成报销包';
  btnExport.disabled = true;
  btnReprocess.classList.add('hidden');
  // 通知服务端清理临时文件
  apiFetch('/api/process/clear', { method: 'POST' }).catch(() => {});
});

// ── 开始识别 ──
async function doProcess(newFileIds) {
  if (!newFileIds || newFileIds.length === 0) return;

  stats = { ok:0, warn:0, err:0, done:0 };
  // 重置新加入文件的状态
  for (const id of newFileIds) setFileStatus(id, 'pending', '等待识别');
  updateRing();
  btnExport.disabled = true;
  btnReprocess.classList.add('hidden');
  btnReprocess.disabled = true;

  // 构建 FormData，上传文件
  const formData = new FormData();
  const fileMeta = [];
  for (const id of newFileIds) {
    const f = files.get(id);
    if (!f) continue;
    formData.append('files', f.file, f.name);
    fileMeta.push({ id: f.id, name: f.name });
  }
  formData.append('fileMeta', JSON.stringify(fileMeta));

  try {
    await fetch('/api/process/files', {
      method: 'POST',
      headers: {
        'x-session-id': SESSION_ID,
        ...(SESSION_TOKEN ? { 'x-session-token': SESSION_TOKEN } : {}),
      },
      body: formData,
    }).then(r => r.json());
  } catch (err) {
    showToast('上传失败：' + err.message);
    btnReprocess.classList.remove('hidden');
    btnReprocess.disabled = false;
  }
}

btnReprocess.addEventListener('click', () => {
  const allIds = [...files.keys()];
  // 清空状态，重新识别所有文件
  stats = { ok:0, warn:0, err:0, done:0 };
  for (const [id, f] of files) { f.status = 'pending'; f.result = undefined; }
  apiFetch('/api/process/clear', { method: 'POST' }).catch(() => {});
  doProcess(allIds);
});

// ── 生成报销包 ──
btnExport.addEventListener('click', async () => {
  btnExport.textContent = '生成中...';
  btnExport.disabled = true;
  showToast('正在生成报销包…');
  try {
    const data = await apiFetch('/api/process/export', { method: 'POST' });
    btnExport.textContent = '生成报销包';
    btnExport.disabled = false;
    showToast(`报销包已生成，共 ${data.tripCount} 个行程，正在下载…`);
    // 触发浏览器下载
    const a = document.createElement('a');
    a.href = `/api/download/${data.downloadId}`;
    a.download = '差旅报销.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (data.tripCards && data.tripCards.length) {
      renderTripDrawer(data.tripCards, data.downloadId);
    }
  } catch (err) {
    showToast('生成失败：' + err.message);
    btnExport.textContent = '生成报销包';
    btnExport.disabled = false;
  }
});

// ── WebSocket 消息处理 ──
function handleWsMessage(msg) {
  switch (msg.type) {
    case 'file-start':
      setFileStatus(msg.fileId, 'processing', '识别中…');
      break;

    case 'file-done': {
      const entry = files.get(msg.fileId);
      if (entry) entry.result = msg.result;
      const result = msg.result;
      const isWarn = result.confidence === 'low';
      const typeLabel = TYPE_LABEL[result.type] || result.type || '';
      let amountStr = null;
      if (result.amount) {
        const sym = result.currency && result.currency !== 'CNY' ? result.currency + ' ' : '¥';
        amountStr = sym + result.amount;
        if (result.currency && result.currency !== 'CNY' && result.amount_cny) {
          amountStr += `(≈¥${result.amount_cny})`;
        }
      }
      const desc = [typeLabel, result.date, amountStr, result.description].filter(Boolean).join(' · ');
      setFileStatus(msg.fileId, isWarn ? 'warn' : 'done', desc || '识别完成');
      if (isWarn) stats.warn++; else stats.ok++;
      stats.done++;
      updateRing();
      checkAllDone();
      break;
    }

    case 'file-error':
      setFileStatus(msg.fileId, 'error', '识别失败');
      stats.err++; stats.done++;
      updateRing();
      showToast('识别失败：' + String(msg.error).slice(0, 40));
      checkAllDone();
      break;

    case 'toast':
      showToast(msg.message);
      break;
  }
}

// ── 行程抽屉 ──
function summaryItem(label, count, unit) {
  if (!count) return '';
  return `<span class="trip-sum-item">${escHtml(label)} <span class="trip-sum-num">${count}</span>${escHtml(unit)}</span>`;
}

function renderTripDrawer(cards, downloadId) {
  const sorted = [
    ...[...cards].filter(c => !c.unmatched).sort((a, b) => (a.startDate || '').localeCompare(b.startDate || '')),
    ...[...cards].filter(c => c.unmatched),
  ];

  tripCards.innerHTML = '';

  for (const card of sorted) {
    const el = document.createElement('div');
    el.className = card.unmatched ? 'trip-card trip-card-unmatched' : 'trip-card';

    let titleText;
    if (card.unmatched) {
      titleText = '未匹配票据';
    } else {
      const dateRange = card.startDate && card.endDate
        ? `${fmtDate(card.startDate)}～${fmtDate(card.endDate)}`
        : (card.startDate ? fmtDate(card.startDate) : '日期未知');
      const cityPart = card.fromCity && card.toCity
        ? ` 从${card.fromCity}到${card.toCity}`
        : (card.fromCity || card.toCity ? ` ${card.fromCity || card.toCity}` : '');
      titleText = dateRange + cityPart;
    }

    const daysText = (!card.unmatched && card.durationDays != null) ? `共 ${card.durationDays}天` : '';
    const purposeText = card.purpose
      ? card.purpose.replace(/^差旅申请单[:：]?/, '').trim()
      : '';

    const summaryHtml = [
      summaryItem('机票', card.flightCount, '张'),
      summaryItem('火车票', card.trainCount, '张'),
      summaryItem('酒店', card.hotelNights, '晚'),
      summaryItem('打车票', card.taxiCount, '张'),
      summaryItem('餐饮', card.mealCount, '张'),
      summaryItem('其他单据', card.otherCount, '张'),
    ].filter(Boolean).join('');

    el.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div class="trip-card-title" style="flex:1;min-width:0">${escHtml(titleText)}</div>
        <div class="trip-card-actions">
          <button class="btn-copy">复制</button>
        </div>
      </div>
      ${purposeText ? `<div class="trip-card-purpose">事由：${escHtml(purposeText)}</div>` : ''}
      ${daysText ? `<div class="trip-card-days">出差时长：${escHtml(daysText)}</div>` : ''}
      ${card.unmatched ? `<div class="trip-card-purpose">无法匹配到差旅申请单，已单独打包</div>` : ''}
      ${summaryHtml ? `<div class="trip-card-summary">${summaryHtml}</div>` : ''}
    `;

    el.querySelector('.btn-copy').addEventListener('click', async (e) => {
      const copyBtn = e.currentTarget;
      const text = buildCopyText(card, titleText, daysText, purposeText);
      await navigator.clipboard.writeText(text).catch(() => {});
      copyBtn.textContent = '已复制';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = '复制'; copyBtn.classList.remove('copied'); }, 1800);
    });

    tripCards.appendChild(el);
  }

  const drawerFooter = document.getElementById('drawer-footer');
  if (drawerFooter) {
    drawerFooter.innerHTML = `
      <a href="/api/download/${escHtml(downloadId)}" download="差旅报销.zip"
         class="open-link" style="color:#a1a1aa;font-size:10px;display:block;line-height:1.8;text-decoration:none">
        📦 点击再次下载报销包
      </a>
    `;
  }

  tripDrawer.classList.add('open');
}

btnCloseDrawer.addEventListener('click', () => tripDrawer.classList.remove('open'));

function fmtDate(d) { return d ? d.replace(/-/g, '/') : ''; }

function buildCopyText(card, titleText, daysText, purposeText) {
  const lines = [];
  lines.push(titleText);
  if (purposeText) lines.push(`事由：${purposeText}`);
  if (daysText) lines.push(`出差时长：共 ${daysText}`);
  lines.push('');
  for (const d of (card.details || [])) lines.push(d.label);
  if (card.totalCny > 0) { lines.push(''); lines.push(`合计费用：¥${Math.round(card.totalCny)}`); }
  return lines.join('\n');
}

// ── 所有文件完成 ──
function checkAllDone() {
  const total = files.size;
  const done  = [...files.values()].filter(f => ['done','warn','error'].includes(f.status)).length;
  if (done < total) return;
  renderAllItems();
  dropZone.classList.add('done');
  btnReprocess.classList.remove('hidden');
  btnReprocess.disabled = false;
  if (stats.ok + stats.warn > 0) btnExport.disabled = false;
}

if (sortSelect) sortSelect.addEventListener('change', () => renderAllItems());

function syncEmpty() {
  const isEmpty = files.size === 0;
  fileEmpty.style.display    = isEmpty ? 'flex' : 'none';
  listHeader.style.display   = isEmpty ? 'none' : 'flex';
  fileListEl.style.display   = isEmpty ? 'none' : '';
  listAddBtn.style.display   = isEmpty ? 'none' : 'flex';
  dropZone.classList.toggle('has-files', !isEmpty);
}

let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('opacity-0');
  toastEl.classList.add('opacity-100');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('opacity-100');
    toastEl.classList.add('opacity-0');
  }, 2800);
}

syncEmpty();
updateRing();

// ── 设置页面 ──
const settingsPage        = document.getElementById('settings-page');
const mainContent         = document.getElementById('main-content');
const btnSettingsBack     = document.getElementById('btn-settings-back');
const settingsModel       = document.getElementById('settings-model');
const settingsCustomModel = document.getElementById('settings-custom-model');
const settingsApiKey      = document.getElementById('settings-api-key');
const settingsBaseUrl     = document.getElementById('settings-base-url');
const btnSettingsSave     = document.getElementById('btn-settings-save');
const settingsStatus      = document.getElementById('settings-status');
const settingsConcurrency     = document.getElementById('settings-concurrency');
const settingsConcurrencyVal  = document.getElementById('settings-concurrency-val');
const settingsDebugLog        = document.getElementById('settings-debug-log');
const settingsLogSize         = document.getElementById('settings-log-size');
const settingsDedupCheck      = document.getElementById('settings-dedup-check');
const settingsFxTarget        = document.getElementById('settings-fx-target');
const btnClearLog             = document.getElementById('btn-clear-log');

// OCR 引擎选项在 Web 版中隐藏（固定 Tesseract）
const ocrEngineRow = document.getElementById('settings-ocr-engine')?.closest('div');
if (ocrEngineRow) ocrEngineRow.style.display = 'none';

function setSettingsStatus(text, isError = false) {
  if (!settingsStatus) return;
  settingsStatus.textContent = text;
  settingsStatus.className = `text-[11px] mb-3 text-center ${isError ? 'text-red-500' : 'text-zinc-400'}`;
}

async function openSettingsPage() {
  if (!settingsPage || !mainContent) return;
  mainContent.classList.add('hidden');
  settingsPage.classList.remove('hidden');
  try {
    const cfg = await apiFetch('/api/config/settings');
    setSettingsStatus('已加载当前配置');
    const presetValues = ['deepseek-v4-pro','deepseek-v4-flash','qwen-3-6-plus','glm-5-1','claude-opus-4-6','claude-opus-4-7','claude-opus-4-8','claude-sonnet-4-6','gpt-5','deepseek-v3-1-terminus-huawei','minimax-m3','qwen3-coder-plus'];
    if (cfg.model) {
      if (presetValues.includes(cfg.model)) {
        settingsModel.value = cfg.model;
        settingsCustomModel?.classList.add('hidden');
      } else {
        settingsModel.value = 'custom';
        settingsCustomModel?.classList.remove('hidden');
        if (settingsCustomModel) settingsCustomModel.value = cfg.model;
      }
    }
    settingsApiKey.value = cfg.token || '';
    if (settingsBaseUrl) settingsBaseUrl.value = cfg.baseUrl || '';
    if (settingsConcurrency) {
      settingsConcurrency.value = Math.min(5, Math.max(1, Number(cfg.concurrency) || 1));
      if (settingsConcurrencyVal) settingsConcurrencyVal.textContent = settingsConcurrency.value;
    }
    if (settingsDebugLog) settingsDebugLog.checked = cfg.debugLog !== false;
    if (settingsDedupCheck) settingsDedupCheck.checked = cfg.dedupCheck !== false;
    if (settingsFxTarget) settingsFxTarget.value = ['CNY','HKD'].includes(cfg.fxTarget) ? cfg.fxTarget : 'CNY';
    if (settingsLogSize) settingsLogSize.textContent = '—';
  } catch (e) {
    setSettingsStatus('加载配置失败', true);
  }
}

function closeSettingsPage() {
  settingsPage?.classList.add('hidden');
  mainContent?.classList.remove('hidden');
}

if (btnSettings) btnSettings.addEventListener('click', e => { e.stopPropagation(); openSettingsPage(); });
if (btnSettingsBack) btnSettingsBack.addEventListener('click', () => closeSettingsPage());

const DEFAULT_BASE_URL = 'http://devpilot.zhonganonline.com/devpilot/v1/external/direct/claudecode';

if (settingsModel) {
  settingsModel.addEventListener('change', () => {
    if (settingsModel.value === 'custom') {
      settingsCustomModel?.classList.remove('hidden');
      settingsCustomModel?.focus();
      if (settingsBaseUrl && settingsBaseUrl.value === DEFAULT_BASE_URL) settingsBaseUrl.value = '';
    } else {
      settingsCustomModel?.classList.add('hidden');
      if (settingsBaseUrl && !settingsBaseUrl.value) settingsBaseUrl.value = DEFAULT_BASE_URL;
    }
  });
}

if (settingsConcurrency && settingsConcurrencyVal) {
  settingsConcurrency.addEventListener('input', () => {
    settingsConcurrencyVal.textContent = settingsConcurrency.value;
  });
}

if (btnClearLog) {
  btnClearLog.addEventListener('click', () => {
    showToast('Web 版暂不支持查看日志文件');
  });
}

if (btnSettingsSave) {
  btnSettingsSave.addEventListener('click', async () => {
    const model = settingsModel.value === 'custom'
      ? String(settingsCustomModel?.value || '').trim()
      : settingsModel.value;
    const token   = String(settingsApiKey.value || '').trim();
    const baseUrl = String(settingsBaseUrl?.value || '').trim() || DEFAULT_BASE_URL;

    if (!token || token.length < 8) {
      setSettingsStatus('请输入有效的 API Key（至少 8 个字符）', true);
      settingsApiKey.focus();
      return;
    }
    if (!model) {
      setSettingsStatus('请选择或输入模型名称', true);
      if (settingsModel.value === 'custom') settingsCustomModel?.focus();
      return;
    }

    btnSettingsSave.disabled = true;
    btnSettingsSave.textContent = '保存中...';
    try {
      await apiFetch('/api/config/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token, model, baseUrl,
          concurrency: settingsConcurrency ? Number(settingsConcurrency.value) : 1,
          debugLog:    settingsDebugLog ? settingsDebugLog.checked : true,
          dedupCheck:  settingsDedupCheck ? settingsDedupCheck.checked : true,
          fxTarget:    settingsFxTarget ? settingsFxTarget.value : 'CNY',
        }),
      });
      setSettingsStatus('保存成功，已生效');
      showToast('设置已保存');
      setTimeout(() => closeSettingsPage(), 600);
    } catch (e) {
      setSettingsStatus(String(e.message || e).slice(0, 80), true);
      showToast('保存失败：' + String(e.message || e).slice(0, 40));
    } finally {
      btnSettingsSave.disabled = false;
      btnSettingsSave.textContent = '保存';
    }
  });
}

if (settingsApiKey) settingsApiKey.addEventListener('keydown', e => { if (e.key === 'Enter') btnSettingsSave?.click(); });
if (settingsCustomModel) settingsCustomModel.addEventListener('keydown', e => { if (e.key === 'Enter') btnSettingsSave?.click(); });
