const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { assertSafeFilePath } = require('./security');

function isPackagedDesktop() {
  try {
    const { app } = require('electron');
    return app.isPackaged;
  } catch (_) {
    return false;
  }
}

// 打包后 bin 路径：开发时在 cwd/bin/，打包后在 resources/bin/
function getOcrTool() {
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'bin', 'ocr_tool');
    }
  } catch (_) {}
  return path.join(process.cwd(), 'bin', 'ocr_tool');
}
const OCR_TOOL = getOcrTool();

function ocrImage(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(OCR_TOOL)) {
      return reject(new Error('OCR 工具不存在，请重新安装应用'));
    }
    execFile(OCR_TOOL, [filePath], { timeout: 60000 }, (err, stdout) => {
      if (err) {
        const msg = err.killed ? 'OCR 超时，请检查文件是否过大' : `OCR 失败: ${err.message}`;
        return reject(new Error(msg));
      }
      resolve((stdout || '').trim());
    });
  });
}

async function ocrTesseract(filePath) {
  if (isPackagedDesktop()) {
    throw new Error('桌面版已精简体积，请使用 macOS 系统 OCR');
  }
  let Tesseract;
  try {
    Tesseract = require('tesseract.js');
  } catch (_) {
    throw new Error('Tesseract.js 未安装，请使用 macOS 系统 OCR');
  }
  const { data: { text } } = await Tesseract.recognize(filePath, 'chi_sim+eng');
  return (text || '').trim();
}

function pdfViaQlmanage(filePath) {
  return new Promise((resolve) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-pdf-'));
    execFile('qlmanage', ['-t', '-s', '1500', '-o', tmpDir, filePath],
      { timeout: 30000 },
      async (err) => {
        try {
          const outName = path.basename(filePath) + '.png';
          const outPath = path.join(tmpDir, outName);
          if (!fs.existsSync(outPath)) {
            const files = fs.readdirSync(tmpDir);
            const found = files.find(f => f.endsWith('.png') || f.endsWith('.jpg'));
            if (!found) return resolve('');
            const text = await ocrImage(path.join(tmpDir, found));
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return resolve(text);
          }
          const text = await ocrImage(outPath);
          fs.rmSync(tmpDir, { recursive: true, force: true });
          resolve(text);
        } catch (e) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
          resolve('');
        }
      }
    );
  });
}

async function extractPdfText(filePath) {
  if (isPackagedDesktop()) return '';
  let pdfParse;
  try {
    pdfParse = require('pdf-parse');
  } catch (_) {
    return '';
  }
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return (data.text || '').trim();
}

async function preparePdf(safePath) {
  if (!isPackagedDesktop()) {
    let text = '';
    try {
      text = await extractPdfText(safePath);
    } catch (e) {
      console.warn(`pdf-parse 失败 [${path.basename(safePath)}]: ${e.message}`);
    }

    if (text && text.length > 10) {
      const readableChars = (text.match(/[\u4e00-\u9fff\u0020-\u007e\n]/g) || []).length;
      const ratio = readableChars / text.length;
      if (ratio >= 0.5) {
        return { inputType: 'text', content: text };
      }
      console.warn(`PDF 疑似乱码 [${path.basename(safePath)}]，可读率 ${(ratio * 100).toFixed(0)}%，改用 OCR`);
    }
  }

  const ocrText = await ocrImage(safePath).catch(() => '');
  if (ocrText && ocrText.length > 3) {
    return { inputType: 'text', content: `[PDF OCR结果]\n${ocrText}` };
  }

  const qlText = await pdfViaQlmanage(safePath).catch(() => '');
  if (qlText && qlText.length > 3) {
    return { inputType: 'text', content: `[PDF渲染OCR结果]\n${qlText}` };
  }

  throw new Error('PDF 无可提取文字，且 OCR 未识别到内容（可能是加密或损坏的 PDF）');
}

async function prepareForAI(filePath, options = {}) {
  const safePath = assertSafeFilePath(filePath);
  const ext = path.extname(safePath).toLowerCase();
  const useTesseract = !isPackagedDesktop() && options.ocrEngine === 'tesseract';

  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
    const text = useTesseract
      ? await ocrTesseract(safePath)
      : await ocrImage(safePath);
    if (!text || text.length < 3) {
      throw new Error('图片 OCR 未识别到有效文字，请确认图片清晰度');
    }
    return { inputType: 'text', content: `[图片OCR结果]\n${text}` };
  }

  if (ext === '.pdf') {
    return preparePdf(safePath);
  }

  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const buffer = fs.readFileSync(safePath);
    const result = await mammoth.extractRawText({ buffer });
    return { inputType: 'text', content: result.value };
  }

  if (ext === '.txt') {
    return { inputType: 'text', content: fs.readFileSync(safePath, 'utf8') };
  }

  throw new Error(`不支持的文件格式: ${ext}，支持 JPG/PNG/PDF/DOCX/TXT`);
}

module.exports = { prepareForAI };
