const api = window.electronAPI;

// ── 状态 ──
const files = new Map();
let stats = { ok: 0, warn: 0, err: 0, done: 0 };
let addedOrder = 0;
let isProcessing = false;
let isExporting = false;
let cfgHasToken = false;

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
const toastEl          = document.getElementById('toast');
const sortSelect       = document.getElementById('sort-select');
const tripDrawer       = document.getElementById('trip-drawer');
const tripCards        = document.getElementById('trip-cards');
const btnCloseDrawer   = document.getElementById('btn-close-drawer');
const btnSettings      = document.getElementById('btn-settings');

// ── 常量 ──
const SUPPORTED  = ['.jpg','.jpeg','.png','.webp','.pdf','.docx','.txt'];
const EXT_ICON   = { '.pdf':'📄', '.jpg':'🖼', '.jpeg':'🖼', '.png':'🖼', '.webp':'🖼', '.docx':'📝', '.txt':'📃' };
const EXT_BG     = { '.pdf':'bg-red-50', '.jpg':'bg-emerald-50', '.jpeg':'bg-emerald-50', '.png':'bg-emerald-50', '.webp':'bg-emerald-50', '.docx':'bg-blue-50' };
const TYPE_LABEL = { flight:'✈ 机票', train:'🚄 火车票', hotel:'🏨 酒店', taxi:'🚕 打车', meal:'🍽 餐饮', apply:'📋 差旅申请', other:'📎 其他' };

// 底部"添加"按钮 → 选文件
document.getElementById('btn-add-file').addEventListener('click', () => fileInput.click());

// ── 拖拽上传 ──
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', e => {
  // 只有真正离开 drop-zone 才取消高亮（避免子元素触发 dragleave）
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('drag-over');
  }
});
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  addFiles([...e.dataTransfer.files]);
});
// 点击空态区域触发文件选择（有文件时点击列表/标题/底栏不触发）
dropZone.addEventListener('click', e => {
  const inList    = fileListEl.contains(e.target);
  const inHeader  = listHeader.contains(e.target);
  const inFooter  = listAddBtn.contains(e.target);
  if (!inList && !inHeader && !inFooter) fileInput.click();
});
fileInput.addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });

// ── 添加文件 ──
function addFiles(list) {
  let added = 0;
  for (const f of list) {
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED.includes(ext)) { showToast(`跳过不支持的文件：${f.name}`); continue; }
    const filePath = api.getPathForFile(f);
    if (!filePath) { showToast(`无法获取路径：${f.name}`); continue; }
    // 重复票据检测：path + size 指纹
    const fingerprint = filePath + '|' + f.size;
    const dedupEnabled = settingsDedupCheck ? settingsDedupCheck.checked : true;
    if (dedupEnabled && [...files.values()].some(x => x._fingerprint === fingerprint)) {
      showToast(`跳过重复票据：${f.name}`);
      continue;
    }
    if (!dedupEnabled && [...files.values()].some(x => x.path === filePath)) continue;
    const id = crypto.randomUUID();
    files.set(id, { id, name: f.name, path: filePath, status: 'pending', _order: addedOrder++, _fingerprint: fingerprint });
    added++;
  }
  if (added) {
    dropZone.classList.remove('done');
    renderAllItems();
    syncEmpty();
    updateRing();
    btnExport.disabled = true;
    btnReprocess.classList.add('hidden');
    doProcess();
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

// ── 排序并重新渲染全部列表项 ──
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
      const ad = a.result?.date || '';
      const bd = b.result?.date || '';
      if (!ad && !bd) return 0;
      if (!ad) return 1;
      if (!bd) return -1;
      return ad < bd ? -1 : ad > bd ? 1 : 0;
    });
  } else {
    entries.sort((a, b) => (a._order || 0) - (b._order || 0));
  }

  // 清空并按顺序重新插入（复用已有 DOM 节点）
  const existing = {};
  fileListEl.querySelectorAll('li[data-id]').forEach(li => { existing[li.dataset.id] = li; });

  // 新增项建节点，全部追加到 fragment 再替换
  const frag = document.createDocumentFragment();
  for (const f of entries) {
    if (existing[f.id]) {
      frag.appendChild(existing[f.id]);
    } else {
      // 临时 append 再取出（renderItem 会 appendChild）
      renderItem(f.id);
      frag.appendChild(fileListEl.lastChild);
    }
  }
  fileListEl.innerHTML = '';
  fileListEl.appendChild(frag);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 文件状态 ──
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
});

// ── 开始识别（指定文件列表） ──
async function doProcessFiles(targetFiles) {
  if (targetFiles.length === 0 || isProcessing) return;
  isProcessing = true;
  btnExport.disabled = true;
  btnReprocess.classList.add('hidden');
  btnReprocess.disabled = true;

  for (const f of targetFiles) setFileStatus(f.id, 'pending', '等待识别');
  updateRing();

  const orderedIds = [...fileListEl.querySelectorAll('li')].map(li => li.dataset.id);
  const payload = orderedIds
    .filter(id => targetFiles.some(f => f.id === id))
    .map(id => { const f = files.get(id); return { id: f.id, name: f.name, path: f.path }; });

  try {
    await api.processFiles(payload);
  } catch (err) {
    showToast('识别出错：' + err.message);
    btnReprocess.classList.remove('hidden');
    btnReprocess.disabled = false;
  } finally {
    isProcessing = false;
  }
}

// ── 全量识别（全部文件重跑） ──
async function doProcess() {
  if (files.size === 0 || isProcessing) return;
  stats = { ok:0, warn:0, err:0, done:0 };
  await doProcessFiles([...files.values()]);
}

btnReprocess.addEventListener('click', () => {
  if (!isProcessing) doProcess();
});

// ── 生成报销包（直接执行，无需确认） ──
btnExport.addEventListener('click', async () => {
  if (isExporting || btnExport.disabled) return;
  isExporting = true;
  btnExport.disabled = true;
  btnExport.textContent = '生成中...';
  showToast('正在生成报销包…');
  try {
    await api.exportPackage();
  } catch (err) {
    showToast('生成失败：' + err.message);
    btnExport.textContent = '生成报销包';
    btnExport.disabled = stats.ok + stats.warn === 0;
  } finally {
    isExporting = false;
  }
});

// ── IPC ──
api.onFileStart(({ fileId }) => setFileStatus(fileId, 'processing', '识别中…'));

api.onFileDone(({ fileId, result }) => {
  // 存储识别结果到 file entry，供排序使用
  const entry = files.get(fileId);
  if (entry) entry.result = result;

  const isWarn = result.confidence === 'low';
  const typeLabel = TYPE_LABEL[result.type] || result.type || '';
  // 金额显示：外币显示原币，人民币显示 ¥
  let amountStr = null;
  if (result.amount) {
    const sym = result.currency && result.currency !== 'CNY' ? result.currency + ' ' : '¥';
    amountStr = sym + result.amount;
    if (result.currency && result.currency !== 'CNY' && result.amount_cny) {
      amountStr += `(≈¥${result.amount_cny})`;
    }
  }
  const desc = [typeLabel, result.date, amountStr, result.description]
    .filter(Boolean).join(' · ');
  setFileStatus(fileId, isWarn ? 'warn' : 'done', desc || '识别完成');
  if (isWarn) stats.warn++; else stats.ok++;
  stats.done++;
  updateRing();
  checkAllDone();
});

api.onFileError(({ fileId, error }) => {
  setFileStatus(fileId, 'error', '识别失败');
  stats.err++; stats.done++;
  updateRing();
  showToast('识别失败：' + String(error).slice(0, 40));
  checkAllDone();
});

// 文件因认证失败被搁置，回到待识别状态（等配置好后重试）
api.onFilePending(({ fileId }) => {
  setFileStatus(fileId, 'pending', '待重试');
});

// 需要 API Key：打开设置页并提示
api.onNeedSetup(() => {
  isProcessing = false;
  showToast('需要配置 API Key，请填写后保存');
  openSettingsPage('needApiKey');
});

// 设置保存后：关闭设置页，自动重试 pending 文件（不重跑已成功的）
api.onSetupSaved(() => {
  closeSettingsPage();
  const pendingFiles = [...files.values()].filter(f => f.status === 'pending');
  if (pendingFiles.length > 0) {
    showToast('配置已保存，正在重试识别…');
    doProcessFiles(pendingFiles);
  } else {
    showToast('配置已保存');
  }
});

api.onProgress(({ message }) => showToast(message));

api.onExportDone(({ zipPath, folderPath, tripCount, tripCards: cards }) => {
  btnExport.textContent = '生成报销包';
  btnExport.disabled = false;
  isExporting = false;
  showToast(`报销包已生成，共 ${tripCount} 个行程`);
  if (cards && cards.length) {
    renderTripDrawer(cards, folderPath, zipPath);
  }
});

// ── 行程抽屉 ──
function summaryItem(label, count, unit) {
  if (!count) return '';
  return `<span class="trip-sum-item">${escHtml(label)} <span class="trip-sum-num">${count}</span>${escHtml(unit)}</span>`;
}

function renderTripDrawer(cards, folderPath, zipPath) {
  // 正常行程按 startDate 排序，未匹配行程排最后
  const sorted = [
    ...[...cards].filter(c => !c.unmatched).sort((a, b) => (a.startDate || '').localeCompare(b.startDate || '')),
    ...[...cards].filter(c => c.unmatched),
  ];

  tripCards.innerHTML = '';

  for (const card of sorted) {
    const el = document.createElement('div');
    el.className = card.unmatched ? 'trip-card trip-card-unmatched' : 'trip-card';

    // 标题
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

    // 出差天数（未匹配行程不显示）
    const daysText = (!card.unmatched && card.durationDays != null) ? `共 ${card.durationDays}天` : '';

    // 事由
    const purposeText = card.purpose
      ? card.purpose.replace(/^差旅申请单[:：]?/, '').trim()
      : '';

    // 票据摘要：各类型分别显示，数字绿色高亮
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
          <button class="btn-view">查看</button>
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
      await api.copyText(text);
      copyBtn.textContent = '已复制';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = '复制'; copyBtn.classList.remove('copied'); }, 1800);
    });

    el.querySelector('.btn-view').addEventListener('click', () => {
      api.openFolder(card.folderPath);
    });

    tripCards.appendChild(el);
  }

  // 底部路径写入独立的 #drawer-footer
  const drawerFooter = document.getElementById('drawer-footer');
  if (drawerFooter) {
    drawerFooter.innerHTML = `
      <span class="open-link" data-path="${escHtml(folderPath)}">📁 ${escHtml(folderPath)}</span>
      <span class="open-link" data-path="${escHtml(zipPath)}" style="margin-top:2px">📦 ${escHtml(zipPath)}</span>
    `;
    drawerFooter.querySelectorAll('.open-link').forEach(el =>
      el.addEventListener('click', () => api.openFolder(el.dataset.path))
    );
  }

  // 展开抽屉
  tripDrawer.classList.add('open');
}

// 关闭抽屉
btnCloseDrawer.addEventListener('click', () => {
  tripDrawer.classList.remove('open');
});

// 格式化日期 YYYY-MM-DD → YYYY/MM/DD
function fmtDate(d) {
  return d ? d.replace(/-/g, '/') : '';
}

// 构建复制文本
function buildCopyText(card, titleText, daysText, purposeText) {
  const lines = [];
  lines.push(titleText);
  if (purposeText) lines.push(`事由：${purposeText}`);
  if (daysText) lines.push(`出差时长：共 ${daysText}`);
  lines.push('');

  for (const d of (card.details || [])) {
    lines.push(d.label);
  }

  if (card.totalCny > 0) {
    lines.push('');
    lines.push(`合计费用：¥${Math.round(card.totalCny)}`);
  }
  return lines.join('\n');
}

// ── 所有文件完成 ──
function checkAllDone() {
  const total = files.size;
  const done  = [...files.values()].filter(f => ['done','warn','error'].includes(f.status)).length;
  if (done < total) return;
  // 识别完成后按当前排序模式重新排列
  renderAllItems();
  dropZone.classList.add('done');
  btnReprocess.classList.remove('hidden');
  btnReprocess.disabled = false;
  if (stats.ok + stats.warn > 0) btnExport.disabled = false;
}

// ── 排序切换 ──
if (sortSelect) {
  sortSelect.addEventListener('change', () => renderAllItems());
}

// ── 辅助 ──
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
const settingsPage       = document.getElementById('settings-page');
const mainContent        = document.getElementById('main-content');
const btnSettingsBack    = document.getElementById('btn-settings-back');
const settingsModel      = document.getElementById('settings-model');
const settingsCustomModel= document.getElementById('settings-custom-model');
const settingsApiKey     = document.getElementById('settings-api-key');
const settingsBaseUrl    = document.getElementById('settings-base-url');
const btnSettingsSave    = document.getElementById('btn-settings-save');
const settingsStatus     = document.getElementById('settings-status');
const settingsConcurrency    = document.getElementById('settings-concurrency');
const settingsConcurrencyVal = document.getElementById('settings-concurrency-val');
const settingsOcrEngine      = document.getElementById('settings-ocr-engine');
const settingsDebugLog       = document.getElementById('settings-debug-log');
const settingsLogSize        = document.getElementById('settings-log-size');
const settingsDedupCheck     = document.getElementById('settings-dedup-check');
const settingsFxTarget       = document.getElementById('settings-fx-target');
const btnClearLog            = document.getElementById('btn-clear-log');

function setSettingsStatus(text, isError = false) {
  if (!settingsStatus) return;
  settingsStatus.textContent = text;
  settingsStatus.className = `text-[11px] mb-3 text-center ${isError ? 'text-red-500' : 'text-zinc-400'}`;
}

async function openSettingsPage(reason) {
  if (!settingsPage || !mainContent) return;
  mainContent.classList.add('hidden');
  settingsPage.classList.remove('hidden');

  // 需要 API Key 时在设置页顶部显示提示
  const setupHint = document.getElementById('settings-setup-hint');
  if (setupHint) {
    if (reason === 'needApiKey') {
      setupHint.textContent = '请配置 API Key 后保存，系统将自动重试识别。';
      setupHint.classList.remove('hidden');
    } else {
      setupHint.classList.add('hidden');
    }
  }

  // 回填已保存配置
  try {
    const cfg = await api.getSettings();
    cfgHasToken = Boolean(cfg.hasToken);
    setSettingsStatus('已加载当前配置');
    if (cfg.model) {
      const presetValues = ['deepseek-v4-pro','deepseek-v4-flash','qwen-3-6-plus','glm-5-1','claude-opus-4-6','claude-opus-4-7','claude-opus-4-8','claude-sonnet-4-6','gpt-5','deepseek-v3-1-terminus-huawei','minimax-m3','qwen3-coder-plus'];
      if (presetValues.includes(cfg.model)) {
        settingsModel.value = cfg.model;
        if (settingsCustomModel) settingsCustomModel.classList.add('hidden');
      } else {
        settingsModel.value = 'custom';
        if (settingsCustomModel) {
          settingsCustomModel.classList.remove('hidden');
          settingsCustomModel.value = cfg.model;
        }
      }
    }
    if (settingsApiKey) {
      if (cfg.hasToken) {
        // 已配置：切换为 text 模式显示掩码（头尾3位 + ***），用户不修改时原样回传
        settingsApiKey.type = 'text';
        settingsApiKey.value = cfg.token || '';
        settingsApiKey.placeholder = '';
      } else {
        settingsApiKey.type = 'text';
        settingsApiKey.value = '';
        settingsApiKey.placeholder = '请输入你的 API Key';
      }
    }
    if (settingsBaseUrl) settingsBaseUrl.value = cfg.baseUrl || '';

    // 回填新增 5 个字段（含默认值）
    if (settingsConcurrency) {
      const con = cfg.concurrency != null ? Number(cfg.concurrency) : 1;
      settingsConcurrency.value = Math.min(5, Math.max(1, con));
      if (settingsConcurrencyVal) settingsConcurrencyVal.textContent = settingsConcurrency.value;
    }
    if (settingsOcrEngine) {
      settingsOcrEngine.value = cfg.ocrEngine === 'tesseract' ? 'tesseract' : 'vision';
    }
    if (settingsDebugLog) settingsDebugLog.checked = cfg.debugLog !== false;
    if (settingsDedupCheck) settingsDedupCheck.checked = cfg.dedupCheck !== false;
    if (settingsFxTarget) settingsFxTarget.value = ['CNY', 'HKD'].includes(cfg.fxTarget) ? cfg.fxTarget : 'CNY';

    refreshLogSize();
  } catch (e) {
    setSettingsStatus('加载配置失败', true);
  }
}

function closeSettingsPage() {
  if (!settingsPage || !mainContent) return;
  settingsPage.classList.add('hidden');
  mainContent.classList.remove('hidden');
}

async function refreshLogSize() {
  if (!settingsLogSize) return;
  try {
    const bytes = await api.getDebugLogSize();
    if (bytes === 0) {
      settingsLogSize.textContent = '0 B';
    } else if (bytes < 1024) {
      settingsLogSize.textContent = bytes + ' B';
    } else if (bytes < 1048576) {
      settingsLogSize.textContent = (bytes / 1024).toFixed(1) + ' KB';
    } else {
      settingsLogSize.textContent = (bytes / 1048576).toFixed(1) + ' MB';
    }
  } catch (_) {
    settingsLogSize.textContent = '—';
  }
}

// 齿轮按钮 → 打开设置页
if (btnSettings) {
  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettingsPage();
  });
}

// 返回按钮
if (btnSettingsBack) {
  btnSettingsBack.addEventListener('click', () => {
    closeSettingsPage();
  });
}

const DEFAULT_BASE_URL = 'http://devpilot.zhonganonline.com/devpilot/v1/external/direct/claudecode';

// 模型下拉切换 → 自定义输入框显隐，Base URL 自动切换
if (settingsModel) {
  settingsModel.addEventListener('change', () => {
    if (settingsModel.value === 'custom') {
      settingsCustomModel?.classList.remove('hidden');
      settingsCustomModel?.focus();
      if (settingsBaseUrl && settingsBaseUrl.value === DEFAULT_BASE_URL) {
        settingsBaseUrl.value = '';
        settingsBaseUrl.focus();
      }
    } else {
      settingsCustomModel?.classList.add('hidden');
      if (settingsBaseUrl && !settingsBaseUrl.value) {
        settingsBaseUrl.value = DEFAULT_BASE_URL;
      }
    }
  });
}

// 并发滑块 → 实时更新显示值
if (settingsConcurrency && settingsConcurrencyVal) {
  settingsConcurrency.addEventListener('input', () => {
    settingsConcurrencyVal.textContent = settingsConcurrency.value;
  });
}

// 清除日志按钮
if (btnClearLog) {
  btnClearLog.addEventListener('click', async () => {
    btnClearLog.disabled = true;
    btnClearLog.textContent = '清除中...';
    try {
      await api.clearDebugLog();
      showToast('日志已清除');
      refreshLogSize();
    } catch (_) {
      showToast('清除日志失败');
    } finally {
      btnClearLog.disabled = false;
      btnClearLog.textContent = '清除日志';
    }
  });
}

// 保存按钮
if (btnSettingsSave) {
  btnSettingsSave.addEventListener('click', async () => {
    const model = settingsModel.value === 'custom'
      ? String(settingsCustomModel?.value || '').trim()
      : settingsModel.value;
    const token = String(settingsApiKey.value || '').trim();
    const baseUrl = String(settingsBaseUrl?.value || '').trim() || DEFAULT_BASE_URL;

    // 含掩码（***）= 保留原 key，不需要校验长度；否则必须 ≥8 字符
    const isMasked = token.includes('***');
    if (!isMasked && (!token || token.length < 8)) {
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
      const concurrency = settingsConcurrency ? Number(settingsConcurrency.value) : 1;
      const ocrEngine = settingsOcrEngine ? settingsOcrEngine.value : 'vision';
      const debugLog = settingsDebugLog ? settingsDebugLog.checked : true;
      const dedupCheck = settingsDedupCheck ? settingsDedupCheck.checked : true;
      const fxTarget = settingsFxTarget ? settingsFxTarget.value : 'CNY';

      await api.saveSettings({
        token: token || (cfgHasToken ? '****' : ''),
        model, baseUrl,
        concurrency,
        ocrEngine,
        debugLog,
        dedupCheck,
        fxTarget,
      });
      setSettingsStatus('保存成功，已生效（无需重启）');
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

// 回车保存（在 API Key / Base URL 输入框中）
if (settingsApiKey) {
  settingsApiKey.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSettingsSave?.click();
  });
  // 用户点击输入框准备输入新 key 时：清空掩码并切换为密码模式
  settingsApiKey.addEventListener('focus', () => {
    if (settingsApiKey.type === 'text' && settingsApiKey.value.includes('***')) {
      settingsApiKey.value = '';
      settingsApiKey.type = 'password';
    }
  });
  // 失去焦点且无内容时，若已有 token 则恢复掩码显示
  settingsApiKey.addEventListener('blur', async () => {
    if (!settingsApiKey.value && cfgHasToken) {
      const cfg = await api.getSettings().catch(() => null);
      if (cfg && cfg.token) {
        settingsApiKey.type = 'text';
        settingsApiKey.value = cfg.token;
      }
    }
  });
}

if (settingsCustomModel) {
  settingsCustomModel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSettingsSave?.click();
  });
}
