/**
 * a flying mom — PaddleOCR (PP-OCRv4) Browser Schedule Table OCR Engine
 *
 * Implements all requirements from OCR Implementation Guides 1/6 ~ 6/6:
 *  - Pure client-side execution in static website (no server/AI upload, no API key)
 *  - ONNX Runtime Web 1.20.1 (WASM, numThreads=1, executionProviders=['wasm'])
 *  - Static model & dictionary loaded lazily via import.meta.url relative paths:
 *      ../models/ch_PP-OCRv4_rec_infer.onnx
 *      ../models/ppocr_keys_v1.txt
 *  - Binary verification on .onnx (prevents HTML error fallback pages)
 *  - Dictionary array: ['', ...dictLines, ' '] verified against model output class count
 *  - Table detection:
 *      1. Horizontal gray line detection (continuous pixel runs + row gray density)
 *      2. Regular row-spacing cluster selection (auto-excludes phone UI & web menus)
 *      3. Vertical line detection within table region -> 6 columns (DATE, FLIGHT, SHOWUP, SECTOR, STD, STA)
 *      4. 2px inner inset per cell to avoid grid borders
 *  - Cell preprocessing:
 *      1. Text bounding box from pixels with RGB mean < 200 (empty cell -> '')
 *      2. 1px margin in original resolution (0/1/2px on retry)
 *      3. Resize to height 48px keeping aspect ratio (max width 320px), right-pad with RGB(128,128,128)
 *      4. Canvas imageSmoothingQuality = 'high', RGB input first (no destructive binarization)
 *      5. Float32 NCHW tensor [1, 3, 48, 320], normalized via pixel / 127.5 - 1
 *  - CTC greedy decoding:
 *      - Argmax per timestep, remove blank index 0, merge consecutive identical indices
 *      - Preserve repeated characters separated by blank (e.g., '522' keeps both '2's)
 *  - Multi-candidate retry & uncertainty flagging:
 *      - Retries uncertain cells with margin 0/1/2px and grayscale
 *      - Compares blue-stroke emphasis preprocessing on blue flight numbers
 *      - Flags avgScore < 0.95, candidate disagreement, invalid airport code, or missing date/time in yellow
 *  - Tesseract.js used only as an auxiliary fallback.
 *
 * Licenses:
 *  - PaddleOCR ch_PP-OCRv4_rec_infer.onnx & ppocr_keys_v1.txt: Apache License 2.0
 *  - ONNX Runtime Web (onnxruntime-web@1.20.1): MIT License
 *  - Tesseract.js: Apache License 2.0
 */

import { getAirport } from './airports.js';
import { parseFlightTime } from './timezone.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & PATHS (Relative to import.meta.url for subpath deployment)
// ─────────────────────────────────────────────────────────────────────────────
const ORT_CDN_URL  = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js';
const ORT_WASM_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const MODEL_URL    = new URL('../models/ch_PP-OCRv4_rec_infer.onnx', import.meta.url).href;
const DICT_URL     = new URL('../models/ppocr_keys_v1.txt', import.meta.url).href;

const INPUT_H = 48;
const INPUT_W = 320;
const INPUT_SHAPE = [1, 3, INPUT_H, INPUT_W];
const SCORE_THRESHOLD = 0.95; // Guide 6/6: < 0.95 highlighted as uncertain (yellow)

// 6 Table Columns
const COL_DATE   = 0;
const COL_FLIGHT = 1;
const COL_SHOWUP = 2;
const COL_SECTOR = 3;
const COL_STD    = 4;
const COL_STA    = 5;

const NON_FLIGHT_PATTERNS = [
  /DAY\s*OFF/i,
  /^OFF$/i,
  /STBY/i,
  /STANDBY/i,
  /확인요망/i,
  /요망/i,
  /^REST$/i,
  /^VAC$/i,
  /^ALV$/i,
  /^ANLV$/i,
  /^EDU$/i,
  /^SIM$/i,
  /^G\/S$/i,
  /^TRAINING$/i,
  /^MEETING$/i,
  /^BLANK$/i
];

// ─────────────────────────────────────────────────────────────────────────────
// LAZY MODEL & RUNTIME LOADER (Guide 2/6)
// ─────────────────────────────────────────────────────────────────────────────
let ortSession = null;
let charDict   = null;
let loadingPromise = null;
let lastDiagnostics = null;

/**
 * Returns diagnostics from the most recent OCR run (model shapes, cell counts, etc.)
 */
export function getLastOCRDiagnostics() {
  return lastDiagnostics;
}

/**
 * Lazy-loads ONNX Runtime Web 1.20.1, PP-OCRv4 rec model, and dictionary.
 * Only triggered when user selects a photo.
 */
export function loadOCR() {
  if (ortSession && charDict) {
    return Promise.resolve({ session: ortSession, dict: charDict });
  }
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    // 1. Load ONNX Runtime Web 1.20.1
    if (!window.ort) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = ORT_CDN_URL;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('ONNX Runtime Web(1.20.1) 로드에 실패했습니다. 네트워크 연결을 확인해주세요.'));
        document.head.appendChild(script);
      });
    }

    const ort = window.ort;
    ort.env.wasm.wasmPaths = ORT_WASM_DIR;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;

    // 2. Load character dictionary (ppocr_keys_v1.txt)
    const dictResp = await fetch(DICT_URL);
    if (!dictResp.ok) {
      throw new Error(`문자 사전 파일을 불러오지 못했습니다 (${dictResp.status}).`);
    }
    const dictContentType = (dictResp.headers.get('content-type') || '').toLowerCase();
    const dictText = await dictResp.text();
    if (dictContentType.includes('text/html') || /^\s*<!doctype\s+html|^\s*<html/i.test(dictText)) {
      throw new Error('문자 사전 경로에서 HTML 오류 페이지가 반환되었습니다.');
    }

    const rawLines = dictText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }
    // Guide 5/6: ['', ...lines, ' ']
    const builtDict = ['', ...rawLines, ' '];

    // 3. Load ONNX recognition model (ch_PP-OCRv4_rec_infer.onnx)
    const modelResp = await fetch(MODEL_URL);
    if (!modelResp.ok) {
      throw new Error(`OCR 모델 파일을 불러오지 못했습니다 (${modelResp.status}).`);
    }
    const modelContentType = (modelResp.headers.get('content-type') || '').toLowerCase();
    if (modelContentType.includes('text/html')) {
      throw new Error('OCR 모델 경로에서 HTML 오류 페이지가 반환되었습니다.');
    }

    const modelBuffer = await modelResp.arrayBuffer();
    if (modelBuffer.byteLength < 100000) {
      throw new Error(`OCR 모델 파일 크기가 비정상적입니다 (${modelBuffer.byteLength} bytes).`);
    }

    // Verify first bytes are not HTML ('<!DO', '<htm', etc.) and valid protobuf binary
    const firstBytes = new Uint8Array(modelBuffer, 0, Math.min(64, modelBuffer.byteLength));
    const headAscii = String.fromCharCode(...firstBytes);
    if (/^\s*<!doctype|^\s*<html/i.test(headAscii) || firstBytes[0] !== 0x08) {
      throw new Error('OCR 모델 파일(.onnx)이 유효한 바이너리가 아닙니다 (HTML 오류 페이지 의심).');
    }

    const session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });

    ortSession = session;
    charDict = builtDict;
    loadingPromise = null;
    return { session: ortSession, dict: charDict };
  })();

  loadingPromise.catch(() => {
    loadingPromise = null;
  });

  return loadingPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE LOADING
// ─────────────────────────────────────────────────────────────────────────────
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      resolve({ img, canvas, ctx, imageData });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지 파일을 읽을 수 없습니다.'));
    };
    img.src = url;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TABLE & CELL DETECTION (Guide 3/6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks whether a pixel is a neutral gray border pixel (table grid line).
 */
function isGrayBorderPixel(r, g, b) {
  const avg = (r + g + b) / 3;
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const diff = maxC - minC;
  return avg >= 145 && avg <= 243 && diff <= 24;
}

/**
 * Detects horizontal gray lines across the image, merges adjacent y rows into single lines,
 * and selects the regular row-spacing table cluster.
 * Also recovers partial horizontal lines on rows where DATE/SHOWUP cells are vertically merged.
 */
function detectTableHorizontalLines(imageData) {
  const { data, width, height } = imageData;
  const xMargin = Math.max(2, Math.round(width * 0.02));
  const scanW = width - xMargin * 2;
  if (scanW < 50 || height < 50) return null;

  const rowStats = new Array(height);
  for (let y = 0; y < height; y++) {
    let grayCount = 0;
    let run = 0;
    let maxRun = 0;
    let minX = width;
    let maxX = 0;

    for (let x = xMargin; x < width - xMargin; x++) {
      const idx = (y * width + x) * 4;
      if (isGrayBorderPixel(data[idx], data[idx + 1], data[idx + 2])) {
        grayCount++;
        run++;
        if (run > maxRun) maxRun = run;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      } else {
        run = 0;
      }
    }
    rowStats[y] = { y, grayCount, maxRun, minX, maxX };
  }

  const rawLines = [];
  for (let y = 0; y < height; y++) {
    const st = rowStats[y];
    const span = st.maxX - st.minX;
    if (
      (st.grayCount >= scanW * 0.42 && st.maxRun >= scanW * 0.10 && span >= scanW * 0.65) ||
      st.maxRun >= scanW * 0.32
    ) {
      rawLines.push(st);
    }
  }

  if (rawLines.length < 4) return null;

  // Merge adjacent y coordinates (within 3px) into a single horizontal line
  const mergedLines = [];
  let group = null;
  for (const item of rawLines) {
    if (!group) {
      group = {
        ySum: item.y * item.grayCount,
        weight: item.grayCount,
        lastY: item.y,
        grayCount: item.grayCount,
        maxRun: item.maxRun,
        minX: item.minX,
        maxX: item.maxX
      };
    } else if (item.y - group.lastY <= 3) {
      group.ySum += item.y * item.grayCount;
      group.weight += item.grayCount;
      group.lastY = item.y;
      group.grayCount = Math.max(group.grayCount, item.grayCount);
      group.maxRun = Math.max(group.maxRun, item.maxRun);
      group.minX = Math.min(group.minX, item.minX);
      group.maxX = Math.max(group.maxX, item.maxX);
    } else {
      mergedLines.push({
        y: Math.round(group.ySum / group.weight),
        grayCount: group.grayCount,
        maxRun: group.maxRun,
        minX: group.minX,
        maxX: group.maxX
      });
      group = {
        ySum: item.y * item.grayCount,
        weight: item.grayCount,
        lastY: item.y,
        grayCount: item.grayCount,
        maxRun: item.maxRun,
        minX: item.minX,
        maxX: item.maxX
      };
    }
  }
  if (group) {
    mergedLines.push({
      y: Math.round(group.ySum / group.weight),
      grayCount: group.grayCount,
      maxRun: group.maxRun,
      minX: group.minX,
      maxX: group.maxX
    });
  }

  if (mergedLines.length < 4) return null;

  const candidateGaps = [];
  for (let i = 1; i < mergedLines.length; i++) {
    const dy = mergedLines[i].y - mergedLines[i - 1].y;
    if (dy >= 10 && dy <= 120) {
      candidateGaps.push(dy);
    }
  }
  if (candidateGaps.length < 3) return null;

  let bestGap = candidateGaps[0];
  let bestGapScore = -1;
  for (const g of candidateGaps) {
    const score = candidateGaps.filter(x => Math.abs(x - g) <= 2).length;
    if (score > bestGapScore) {
      bestGapScore = score;
      bestGap = g;
    }
  }
  const nearGaps = candidateGaps.filter(x => Math.abs(x - bestGap) <= 2);
  const medianGap = nearGaps.reduce((a, b) => a + b, 0) / nearGaps.length;
  const tol = Math.max(3, Math.round(medianGap * 0.28));

  let bestCluster = [];
  let curCluster = [mergedLines[0]];

  for (let i = 1; i < mergedLines.length; i++) {
    const prev = curCluster[curCluster.length - 1];
    const curr = mergedLines[i];
    const dy = curr.y - prev.y;

    if (Math.abs(dy - medianGap) <= tol) {
      curCluster.push(curr);
    } else if (Math.abs(dy - medianGap * 2) <= tol * 1.6) {
      const midY = Math.round((prev.y + curr.y) / 2);
      let bestMid = rowStats[midY];
      for (let sy = Math.max(prev.y + 4, midY - 3); sy <= Math.min(curr.y - 4, midY + 3); sy++) {
        if (rowStats[sy].grayCount > bestMid.grayCount) {
          bestMid = rowStats[sy];
        }
      }
      if (bestMid.grayCount >= scanW * 0.25) {
        curCluster.push({
          y: bestMid.y,
          grayCount: bestMid.grayCount,
          maxRun: bestMid.maxRun,
          minX: prev.minX,
          maxX: prev.maxX
        });
      }
      curCluster.push(curr);
    } else {
      if (curCluster.length > bestCluster.length) {
        bestCluster = curCluster;
      }
      curCluster = [curr];
    }
  }
  if (curCluster.length > bestCluster.length) {
    bestCluster = curCluster;
  }

  if (bestCluster.length < 4) return null;

  const rowYs = bestCluster.map(l => l.y);
  const minX = Math.min(...bestCluster.map(l => l.minX));
  const maxX = Math.max(...bestCluster.map(l => l.maxX));

  return {
    tableTop: rowYs[0],
    tableBottom: rowYs[rowYs.length - 1],
    rowYs,
    rowGap: medianGap,
    approxLeft: minX,
    approxRight: maxX
  };
}

/**
 * Detects vertical lines inside [tableTop, tableBottom] and returns 7 column boundary x-coordinates
 * for the 6 columns: DATE, FLIGHT, SHOWUP, SECTOR, STD, STA.
 */
function detectTableColumns(imageData, tableRegion) {
  const { data, width } = imageData;
  const { tableTop, tableBottom } = tableRegion;
  const tableH = tableBottom - tableTop;
  if (tableH < 30) return null;

  const colCandidates = [];
  for (let x = 0; x < width; x++) {
    let grayCount = 0;
    for (let y = tableTop; y <= tableBottom; y++) {
      const idx = (y * width + x) * 4;
      if (isGrayBorderPixel(data[idx], data[idx + 1], data[idx + 2])) {
        grayCount++;
      }
    }
    if (grayCount >= tableH * 0.55) {
      colCandidates.push({ x, grayCount });
    }
  }

  const mergedX = [];
  let grp = null;
  for (const c of colCandidates) {
    if (!grp) {
      grp = { xSum: c.x * c.grayCount, weight: c.grayCount, lastX: c.x, maxCount: c.grayCount };
    } else if (c.x - grp.lastX <= 3) {
      grp.xSum += c.x * c.grayCount;
      grp.weight += c.grayCount;
      grp.lastX = c.x;
      grp.maxCount = Math.max(grp.maxCount, c.grayCount);
    } else {
      mergedX.push({ x: Math.round(grp.xSum / grp.weight), strength: grp.maxCount });
      grp = { xSum: c.x * c.grayCount, weight: c.grayCount, lastX: c.x, maxCount: c.grayCount };
    }
  }
  if (grp) {
    mergedX.push({ x: Math.round(grp.xSum / grp.weight), strength: grp.maxCount });
  }

  const minColW = Math.max(24, Math.round(width * 0.075));
  const filtered = [];
  for (const line of mergedX) {
    if (filtered.length === 0) {
      filtered.push(line);
    } else {
      const prev = filtered[filtered.length - 1];
      if (line.x - prev.x >= minColW) {
        filtered.push(line);
      } else if (line.strength > prev.strength) {
        filtered[filtered.length - 1] = line;
      }
    }
  }

  if (filtered.length >= 7) {
    return filtered.slice(0, 7).map(l => l.x);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CELL PREPROCESSING & TENSOR GENERATION (Guide 4/6 & 6/6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fast check whether a cell has any text pixels (RGB mean < threshold) inside its 2px inset boundary.
 */
function inspectCellBBox(srcImageData, x1, y1, x2, y2, threshold = 200) {
  const { data, width, height } = srcImageData;
  const borderInset = 2;
  const cx1 = Math.max(0, x1 + borderInset);
  const cy1 = Math.max(0, y1 + borderInset);
  const cx2 = Math.min(width - 1, x2 - borderInset);
  const cy2 = Math.min(height - 1, y2 - borderInset);

  const cw = cx2 - cx1 + 1;
  const ch = cy2 - cy1 + 1;
  if (cw <= 2 || ch <= 2) {
    return { isEmpty: true, hasBluePixels: false };
  }

  let minX = cw, maxX = -1, minY = ch, maxY = -1;
  let darkPixelCount = 0;
  let bluePixelCount = 0;

  for (let y = 0; y < ch; y++) {
    const sy = cy1 + y;
    for (let x = 0; x < cw; x++) {
      const sx = cx1 + x;
      const idx = (sy * width + sx) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      if ((r + g + b) / 3 < threshold) {
        darkPixelCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (b > r + 25 && b > g + 10) {
          bluePixelCount++;
        }
      }
    }
  }

  if (darkPixelCount < 2 || maxX < minX || maxY < minY) {
    return { isEmpty: true, hasBluePixels: false };
  }

  return {
    isEmpty: false,
    hasBluePixels: bluePixelCount >= 3,
    cx1, cy1, cw, ch,
    minX, maxX, minY, maxY
  };
}

// Reusable offscreen canvases to avoid DOM allocation overhead per cell
let sharedCropCanvas = null;
let sharedCropCtx = null;
let sharedOutCanvas = null;
let sharedOutCtx = null;

/**
 * Crops a cell (inset by 2px to avoid grid borders), locates the text bounding box
 * using pixels with RGB average < 200, adds `marginPx` (default 1px) in original coordinates,
 * scales to height 48px preserving aspect ratio (max width 320px), fills remaining right region
 * with RGB(128,128,128), and builds a Float32 NCHW tensor [1, 3, 48, 320] normalized via pixel/127.5 - 1.
 */
function buildCellInputTensor(srcImageData, x1, y1, x2, y2, options = {}) {
  const { marginPx = 1, mode = 'rgb', bboxInfo = null, threshold = 200 } = options;
  const info = bboxInfo || inspectCellBBox(srcImageData, x1, y1, x2, y2, threshold);
  if (info.isEmpty) {
    return { tensor: null, isEmpty: true, hasBluePixels: false };
  }

  const { data, width } = srcImageData;
  const { cx1, cy1, cw, ch, minX, maxX, minY, maxY, hasBluePixels } = info;

  // Guide 4/6: Add ~1px margin (or 0/1/2px on retry) in original coordinates
  const bx1 = Math.max(0, minX - marginPx);
  const by1 = Math.max(0, minY - marginPx);
  const bx2 = Math.min(cw - 1, maxX + marginPx);
  const by2 = Math.min(ch - 1, maxY + marginPx);

  const bw = bx2 - bx1 + 1;
  const bh = by2 - by1 + 1;
  if (bw <= 0 || bh <= 0) {
    return { tensor: null, isEmpty: true, hasBluePixels: false };
  }

  if (!sharedCropCanvas) {
    sharedCropCanvas = document.createElement('canvas');
    sharedCropCtx = sharedCropCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (sharedCropCanvas.width !== bw || sharedCropCanvas.height !== bh) {
    sharedCropCanvas.width = bw;
    sharedCropCanvas.height = bh;
  }
  const cropID = sharedCropCtx.createImageData(bw, bh);
  const dst = cropID.data;

  for (let y = 0; y < bh; y++) {
    const sy = cy1 + by1 + y;
    for (let x = 0; x < bw; x++) {
      const sx = cx1 + bx1 + x;
      const sIdx = (sy * width + sx) * 4;
      const dIdx = (y * bw + x) * 4;
      let r = data[sIdx];
      let g = data[sIdx + 1];
      let b = data[sIdx + 2];

      if (mode === 'gray') {
        const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        r = g = b = lum;
      } else if (mode === 'blue_red') {
        // Blue ink absorbs red light strongly -> Red channel maximizes blue stroke contrast
        r = g = b = r;
      } else if (mode === 'blue_gamma') {
        // Gamma-enhanced red channel to preserve thin horizontal strokes on '2' and '4'
        const v = Math.round(Math.pow(r / 255.0, 1.8) * 255);
        r = g = b = v;
      }

      dst[dIdx]     = r;
      dst[dIdx + 1] = g;
      dst[dIdx + 2] = b;
      dst[dIdx + 3] = 255;
    }
  }
  sharedCropCtx.putImageData(cropID, 0, 0);

  // Guide 4/6: Scale to height 48px preserving aspect ratio, max width 320px, right pad RGB(128,128,128)
  const targetW = Math.min(INPUT_W, Math.max(1, Math.round(bw * (INPUT_H / bh))));
  if (!sharedOutCanvas) {
    sharedOutCanvas = document.createElement('canvas');
    sharedOutCanvas.width = INPUT_W;
    sharedOutCanvas.height = INPUT_H;
    sharedOutCtx = sharedOutCanvas.getContext('2d', { willReadFrequently: true });
  }

  sharedOutCtx.fillStyle = 'rgb(128, 128, 128)';
  sharedOutCtx.fillRect(0, 0, INPUT_W, INPUT_H);

  sharedOutCtx.imageSmoothingEnabled = true;
  sharedOutCtx.imageSmoothingQuality = 'high';
  sharedOutCtx.drawImage(sharedCropCanvas, 0, 0, bw, bh, 0, 0, targetW, INPUT_H);

  const outPixels = sharedOutCtx.getImageData(0, 0, INPUT_W, INPUT_H).data;

  // Guide 4/6: float32, shape [1, 3, 48, 320], RGB channel order, NCHW layout, pixel / 127.5 - 1
  const planeSize = INPUT_H * INPUT_W;
  const tensor = new Float32Array(3 * planeSize);

  for (let i = 0; i < planeSize; i++) {
    const pIdx = i * 4;
    tensor[i]                 = outPixels[pIdx]     / 127.5 - 1.0; // R
    tensor[planeSize + i]     = outPixels[pIdx + 1] / 127.5 - 1.0; // G
    tensor[planeSize * 2 + i] = outPixels[pIdx + 2] / 127.5 - 1.0; // B
  }

  return {
    tensor,
    isEmpty: false,
    hasBluePixels
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CTC DECODING & MULTI-CANDIDATE CELL INFERENCE (Guide 5/6 & 6/6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CTC greedy decoding (Guide 5/6):
 * - Selects argmax character index at each time step
 * - Excludes blank index 0
 * - Merges consecutive identical indices, while keeping repeated characters separated by blank (e.g., 522)
 */
function decodeCTC(outputData, timeSteps, numClasses, dict) {
  let text = '';
  let scoreSum = 0;
  let charCount = 0;
  let prevIdx = 0;

  for (let t = 0; t < timeSteps; t++) {
    const offset = t * numClasses;
    let maxIdx = 0;
    let maxVal = -Infinity;

    for (let c = 0; c < numClasses; c++) {
      const val = outputData[offset + c];
      if (val > maxVal) {
        maxVal = val;
        maxIdx = c;
      }
    }

    if (maxIdx !== 0 && maxIdx !== prevIdx) {
      const ch = dict[maxIdx] ?? '';
      text += ch;
      const prob = (maxVal >= 0 && maxVal <= 1.0001) ? maxVal : 1.0;
      scoreSum += prob;
      charCount++;
    }
    prevIdx = maxIdx;
  }

  return {
    text: text.trim(),
    avgScore: charCount > 0 ? scoreSum / charCount : 1.0,
    charCount
  };
}

/**
 * Runs a single forward pass on the ONNX session
 */
async function runSingleInference(session, dict, tensorData, diagnosticsSink) {
  const ort = window.ort;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const inputTensor = new ort.Tensor('float32', tensorData, INPUT_SHAPE);
  const results = await session.run({ [inputName]: inputTensor });
  const outputTensor = results[outputName];

  const dims = outputTensor.dims; // [1, T, C]
  const timeSteps = dims[1];
  const numClasses = dims[2];

  // Guide 5/6: Verify dictionary length matches model output classes
  if (dict.length !== numClasses) {
    throw new Error(`사전 크기(${dict.length})와 모델 출력 클래스 수(${numClasses})가 일치하지 않습니다.`);
  }

  if (diagnosticsSink && !diagnosticsSink.outputShape) {
    diagnosticsSink.inputShape = [...INPUT_SHAPE];
    diagnosticsSink.outputShape = [...dims];
    diagnosticsSink.dictLength = dict.length;
    diagnosticsSink.inputName = inputName;
    diagnosticsSink.outputName = outputName;
  }

  return decodeCTC(outputTensor.data, timeSteps, numClasses, dict);
}

/**
 * Runs a batched forward pass [B, 3, 48, 320] on the ONNX session for multiple cells at once.
 */
async function runBatchInference(session, dict, tensorList, diagnosticsSink) {
  if (!tensorList || tensorList.length === 0) return [];
  if (tensorList.length === 1) {
    return [await runSingleInference(session, dict, tensorList[0], diagnosticsSink)];
  }

  const ort = window.ort;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const B = tensorList.length;
  const singleLen = 3 * INPUT_H * INPUT_W;
  const batchData = new Float32Array(B * singleLen);

  for (let b = 0; b < B; b++) {
    batchData.set(tensorList[b], b * singleLen);
  }

  const inputTensor = new ort.Tensor('float32', batchData, [B, 3, INPUT_H, INPUT_W]);
  const results = await session.run({ [inputName]: inputTensor });
  const outputTensor = results[outputName];

  const dims = outputTensor.dims; // [B, T, C]
  const timeSteps = dims[1];
  const numClasses = dims[2];

  if (dict.length !== numClasses) {
    throw new Error(`사전 크기(${dict.length})와 모델 출력 클래스 수(${numClasses})가 일치하지 않습니다.`);
  }

  if (diagnosticsSink && !diagnosticsSink.outputShape) {
    diagnosticsSink.inputShape = [...INPUT_SHAPE];
    diagnosticsSink.outputShape = [1, timeSteps, numClasses];
    diagnosticsSink.dictLength = dict.length;
    diagnosticsSink.inputName = inputName;
    diagnosticsSink.outputName = outputName;
  }

  const outLen = timeSteps * numClasses;
  const decodedList = new Array(B);
  for (let b = 0; b < B; b++) {
    const slice = outputTensor.data.subarray(b * outLen, (b + 1) * outLen);
    decodedList[b] = decodeCTC(slice, timeSteps, numClasses, dict);
  }
  return decodedList;
}

/**
 * Checks if a cell text matches the expected format of its column
 */
function isCellFormatClean(text, colIdx) {
  if (!text) return true;
  const trimmed = text.trim();
  if (colIdx === COL_DATE) {
    return /(0?[1-9]|1[0-2])\s*\/\s*(0?[1-9]|[12]\d|3[01])/.test(trimmed) || /^DATE$/i.test(trimmed);
  }
  if (colIdx === COL_FLIGHT) {
    if (/^([A-Z]{2}\s*)?\d{3,4}[A-Z]?$/i.test(trimmed)) return true;
    if (/^[A-Z]{3}$/.test(trimmed) && getAirport(trimmed)) return true;
    if (NON_FLIGHT_PATTERNS.some(rx => rx.test(trimmed))) return true;
    if (/^FLIGHT$/i.test(trimmed)) return true;
    return false;
  }
  if (colIdx === COL_SECTOR) {
    if (/^SECTOR$/i.test(trimmed)) return true;
    const clean = trimmed.replace(/[^A-Z0-9\/\-]/gi, '').toUpperCase();
    const m = clean.match(/^([A-Z]{3})[\/\-]?([A-Z]{3})$/);
    if (!m) return false;
    return Boolean(getAirport(m[1]) && getAirport(m[2]));
  }
  if (colIdx === COL_STD || colIdx === COL_STA) {
    if (/^(STD|STA)$/i.test(trimmed)) return true;
    const digits = trimmed.replace(/\D/g, '');
    return digits.length === 6;
  }
  return true;
}

/**
 * Normalizes text for candidate comparison
 */
function normalizeForComparison(text, colIdx) {
  if (!text) return '';
  const s = text.replace(/\s+/g, '').toUpperCase();
  if (colIdx === COL_DATE) {
    const m = s.match(/(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])/);
    return m ? `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}` : s;
  }
  if (colIdx === COL_STD || colIdx === COL_STA) {
    return s.replace(/\D/g, '');
  }
  if (colIdx === COL_SECTOR) {
    return s.replace(/[^A-Z]/g, '');
  }
  return s.replace(/[^A-Z0-9]/g, '');
}

/**
 * Recognizes a single table cell.
 * Guide 6/6:
 * - If recognition is uncertain, retries only that cell with margin 0/1/2px or grayscale.
 * - For blue flight numbers, also compares blue-stroke emphasis preprocessing.
 * - If candidates disagree, never blindly trusts the top score as guaranteed truth — marks as `needsCheck = true` (yellow).
 */
async function recognizeTableCell(session, dict, imageData, x1, y1, x2, y2, colIdx, diagnosticsSink, allowMultiRetry = true, precomputedBBox = null, precomputedPrimary = null) {
  const bboxInfo = precomputedBBox || inspectCellBBox(imageData, x1, y1, x2, y2, 200);
  if (bboxInfo.isEmpty) {
    return {
      text: '',
      avgScore: 1.0,
      isEmpty: true,
      candidateDisagreement: false,
      needsCheck: false,
      candidates: []
    };
  }

  // Primary candidate: RGB input, margin 1px
  let primary = precomputedPrimary;
  if (!primary) {
    const basePrep = buildCellInputTensor(imageData, x1, y1, x2, y2, { marginPx: 1, mode: 'rgb', bboxInfo });
    primary = await runSingleInference(session, dict, basePrep.tensor, diagnosticsSink);
  }
  const candidates = [{ label: 'rgb_m1', ...primary }];
  const formatClean = isCellFormatClean(primary.text, colIdx);

  // Guide 6/6: Blue flight numbers are compared against blue-stroke emphasis preprocessing
  // Only run secondary blue passes when format is incomplete or confidence is low
  const isBlueFlight = allowMultiRetry && colIdx === COL_FLIGHT && bboxInfo.hasBluePixels;
  if (isBlueFlight && (!formatClean || primary.avgScore < 0.85)) {
    const blueGammaPrep = buildCellInputTensor(imageData, x1, y1, x2, y2, { marginPx: 1, mode: 'blue_gamma', bboxInfo });
    if (!blueGammaPrep.isEmpty) {
      const bgRes = await runSingleInference(session, dict, blueGammaPrep.tensor, diagnosticsSink);
      if (bgRes.text) candidates.push({ label: 'blue_gamma_m1', ...bgRes });
    }
    // If neither primary nor blue_gamma produced a clean 3-4 digit flight number (e.g., '134' read as '13'), also run blue_red_m1
    if (!candidates.some(c => isCellFormatClean(c.text, colIdx))) {
      const blueRedPrep = buildCellInputTensor(imageData, x1, y1, x2, y2, { marginPx: 1, mode: 'blue_red', bboxInfo });
      if (!blueRedPrep.isEmpty) {
        const brRes = await runSingleInference(session, dict, blueRedPrep.tensor, diagnosticsSink);
        if (brRes.text) candidates.push({ label: 'blue_red_m1', ...brRes });
      }
    }
  }

  // Only retry SECTOR / STD / STA when the primary pass failed format/airport validation (or very low confidence)
  const shouldRetry =
    allowMultiRetry &&
    !isBlueFlight &&
    colIdx !== COL_DATE &&
    colIdx !== COL_SHOWUP &&
    (!formatClean || primary.avgScore < 0.75);

  if (shouldRetry) {
    if (colIdx === COL_SECTOR) {
      // Try margin 2px with wider anti-aliased bbox (threshold 215) first — resolves FUK/ICN and ICN/YNJ in 1 pass
      const wideBBox = inspectCellBBox(imageData, x1, y1, x2, y2, 215);
      if (!wideBBox.isEmpty) {
        const widePrep = buildCellInputTensor(imageData, x1, y1, x2, y2, { marginPx: 2, mode: 'rgb', bboxInfo: wideBBox, threshold: 215 });
        if (!widePrep.isEmpty) {
          const wideRes = await runSingleInference(session, dict, widePrep.tensor, diagnosticsSink);
          if (wideRes.text) candidates.push({ label: 'rgb_m2_t215', ...wideRes });
        }
      }
    }

    if (!candidates.some(c => isCellFormatClean(c.text, colIdx))) {
      const prepM2 = buildCellInputTensor(imageData, x1, y1, x2, y2, { marginPx: 2, mode: 'rgb', bboxInfo });
      if (!prepM2.isEmpty) {
        const resM2 = await runSingleInference(session, dict, prepM2.tensor, diagnosticsSink);
        if (resM2.text) candidates.push({ label: 'rgb_m2', ...resM2 });
      }
    }

    if (!candidates.some(c => isCellFormatClean(c.text, colIdx))) {
      for (const cfg of [
        { label: 'rgb_m0', marginPx: 0, mode: 'rgb' },
        { label: 'gray_m1', marginPx: 1, mode: 'gray' }
      ]) {
        const prep = buildCellInputTensor(imageData, x1, y1, x2, y2, { ...cfg, bboxInfo });
        if (!prep.isEmpty) {
          const res = await runSingleInference(session, dict, prep.tensor, diagnosticsSink);
          if (res.text) candidates.push({ label: cfg.label, ...res });
        }
      }
    }
  }

  // Check if candidates agree after normalization
  const normSet = new Set(
    candidates
      .map(c => normalizeForComparison(c.text, colIdx))
      .filter(s => s.length > 0)
  );
  const candidateDisagreement = normSet.size > 1;

  // Select best candidate for initial editor display (while preserving candidateDisagreement flag!)
  let chosen = primary;
  const validCandidates = candidates.filter(c => c.text && isCellFormatClean(c.text, colIdx));

  if (isBlueFlight && validCandidates.length > 0) {
    // For blue flight numbers where thin strokes on '2' or '4' can fade in raw RGB,
    // prefer valid 3-4 digit blue-emphasis candidate (blue_gamma_m1 / blue_red_m1) if available
    const blueValid = validCandidates.filter(c => c.label.startsWith('blue_'));
    if (blueValid.length > 0) {
      // Among blue-enhanced valid 3-4 digit candidates, prefer blue_gamma_m1 if it is 3-4 digits, else highest score
      const gammaCand = blueValid.find(c => c.label === 'blue_gamma_m1');
      chosen = gammaCand || blueValid.reduce((b, c) => (c.avgScore > b.avgScore ? c : b), blueValid[0]);
    } else {
      chosen = validCandidates.reduce((b, c) => (c.avgScore > b.avgScore ? c : b), validCandidates[0]);
    }
  } else if (validCandidates.length > 0) {
    chosen = validCandidates.reduce((best, cur) => (cur.avgScore > best.avgScore ? cur : best), validCandidates[0]);
  } else {
    chosen = candidates.reduce((best, cur) => (cur.avgScore > best.avgScore ? cur : best), primary);
  }

  const needsCheck =
    chosen.avgScore < SCORE_THRESHOLD ||
    candidateDisagreement ||
    !isCellFormatClean(chosen.text, colIdx);

  return {
    text: chosen.text,
    avgScore: chosen.avgScore,
    isEmpty: false,
    candidateDisagreement,
    needsCheck,
    candidates: candidates.map(c => ({ label: c.label, text: c.text, score: Number(c.avgScore.toFixed(4)) }))
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// YEAR/MONTH & FIELD PARSERS (Guide 5/6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads year and month from above the table (header dropdowns like "2026년", "10월")
 * using PaddleOCR on detected text boxes above tableTop, combined with DATE column month statistics.
 */
async function detectYearMonthFromHeaderAndDates(session, dict, imageData, tableRegion, dateColumnTexts, fallbackYearMonth, diagnosticsSink) {
  let [fallbackY, fallbackM] = (fallbackYearMonth || '2026-10').split('-').map(Number);
  let detectedYear = null;
  let detectedMonth = null;

  // 1. Extract month from DATE column cells (e.g., "10/01(목)", "10/02(금)")
  const monthCounts = new Map();
  for (const txt of dateColumnTexts) {
    if (!txt) continue;
    const m = txt.match(/(?:^|\D)(0?[1-9]|1[0-2])\s*\/\s*(0?[1-9]|[12]\d|3[01])/);
    if (m) {
      const mon = parseInt(m[1], 10);
      monthCounts.set(mon, (monthCounts.get(mon) || 0) + 1);
    }
  }
  if (monthCounts.size > 0) {
    let bestM = null, bestCnt = 0;
    for (const [mon, cnt] of monthCounts.entries()) {
      if (cnt > bestCnt) {
        bestCnt = cnt;
        bestM = mon;
      }
    }
    detectedMonth = bestM;
  }

  // 2. Scan the band above tableTop for year/month text boxes (e.g., "2026년", "10월")
  const scanTop = Math.max(0, Math.round(tableRegion.tableTop - tableRegion.rowGap * 4.5));
  const scanBottom = Math.max(0, tableRegion.tableTop - 4);
  if (scanBottom - scanTop >= 10) {
    const { data, width } = imageData;
    let inTextRow = false;
    let rowStart = scanTop;
    const textBands = [];

    for (let y = scanTop; y <= scanBottom; y++) {
      let darkCnt = 0;
      for (let x = 10; x < width - 10; x++) {
        const idx = (y * width + x) * 4;
        if ((data[idx] + data[idx + 1] + data[idx + 2]) / 3 < 170) {
          darkCnt++;
        }
      }
      if (darkCnt >= 8 && !inTextRow) {
        inTextRow = true;
        rowStart = y;
      } else if (darkCnt < 8 && inTextRow) {
        inTextRow = false;
        if (y - rowStart >= 5) {
          textBands.push([Math.max(scanTop, rowStart - 2), Math.min(scanBottom, y + 2)]);
        }
      }
    }
    if (inTextRow && scanBottom - rowStart >= 5) {
      textBands.push([Math.max(scanTop, rowStart - 2), scanBottom]);
    }

    if (textBands.length > 0) {
      const [by1, by2] = textBands[0];
      const prep = buildCellInputTensor(imageData, 0, by1, Math.round(width * 0.25), by2, { marginPx: 1, mode: 'rgb' });
      if (!prep.isEmpty) {
        const res = await runSingleInference(session, dict, prep.tensor, diagnosticsSink);
        const yMatch = res.text.match(/(20\d{2})/);
        if (yMatch) {
          detectedYear = parseInt(yMatch[1], 10);
        }
        if (!detectedMonth) {
          const mMatch = res.text.match(/(?:년|\s|^)(0?[1-9]|1[0-2])\s*월/);
          if (mMatch) {
            detectedMonth = parseInt(mMatch[1], 10);
          }
        }
      }
    }
  }

  const finalY = detectedYear || fallbackY;
  const finalM = detectedMonth || fallbackM;
  return `${String(finalY).padStart(4, '0')}-${String(finalM).padStart(2, '0')}`;
}

/**
 * Parses DATE cell text such as "10/01(목)", "10/02(금)", "1008호)", "01"
 */
function parseDateColumnText(raw, targetMonth = null) {
  if (!raw) return { month: null, day: null };
  const s = raw.trim();

  // Pattern 1: Explicit separator (/, :, ., -, space) between month and day
  const sepMatch = s.match(/(0?[1-9]|1[0-2])\s*[\/:\-\.\s]\s*([12]\d|3[01]|0?[1-9])(?!\d)/);
  if (sepMatch) {
    return {
      month: parseInt(sepMatch[1], 10),
      day: parseInt(sepMatch[2], 10)
    };
  }

  // Pattern 2: 4-digit MMDD without separator (e.g. "1008호)", "1016()")
  const mmddMatch = s.match(/(0[1-9]|1[0-2])([0-2]\d|3[01])/);
  if (mmddMatch) {
    return {
      month: parseInt(mmddMatch[1], 10),
      day: parseInt(mmddMatch[2], 10)
    };
  }

  // Pattern 3: If targetMonth is given, match targetMonth followed by day digits
  if (targetMonth) {
    const tmStr = String(targetMonth).padStart(2, '0');
    const tmRegex = new RegExp(`(?:^|\\D)(?:${targetMonth}|${tmStr})\\D*?([12]\\d|3[01]|0?[1-9])(?!\\d)`);
    const tmMatch = s.match(tmRegex);
    if (tmMatch) {
      return {
        month: targetMonth,
        day: parseInt(tmMatch[1], 10)
      };
    }
  }

  // Pattern 4: Standalone day
  const dayMatch = s.match(/(?:^|\D)([12]\d|3[01]|0?[1-9])(?!\d)/);
  if (dayMatch) {
    return {
      month: null,
      day: parseInt(dayMatch[1], 10)
    };
  }

  return { month: null, day: null };
}

/**
 * Resolves calendar day (1..31) for each physical row in the schedule table.
 * Uses a robust multi-pass constraint solver combining high-confidence flight STD departure
 * dates, parsed DATE cells, and monotonic day interpolation.
 */
function resolveTableCalendarDays(gridCells, yearNum, monthNum) {
  const numRows = gridCells.length;
  const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
  const rowDays = new Array(numRows).fill(null);

  // Pass 1: High-confidence flight STD departure dates (DD in DDHH:mm)
  for (let r = 0; r < numRows; r++) {
    const row = gridCells[r];
    const fltText = (row[COL_FLIGHT]?.text || '').trim();
    if (fltText === 'FLIGHT' || (row[COL_STD]?.text || '').trim() === 'STD') continue;

    const stdParsed = parseStdStaColumnText(row[COL_STD]?.text || '', yearNum, monthNum);
    if (stdParsed.valid && stdParsed.day) {
      rowDays[r] = stdParsed.day;
    }
  }

  // Ensure first data row defaults to day 1 if unassigned
  let firstDataRow = -1;
  for (let r = 0; r < numRows; r++) {
    if ((gridCells[r][COL_FLIGHT]?.text || '').trim() !== 'FLIGHT') {
      firstDataRow = r;
      break;
    }
  }
  if (firstDataRow >= 0 && rowDays[firstDataRow] === null) {
    const d0 = parseDateColumnText(gridCells[firstDataRow][COL_DATE]?.text || '', monthNum);
    rowDays[firstDataRow] = (d0.day !== null && d0.day <= 5) ? d0.day : 1;
  }

  // Pass 2: Exact span interpolation between known anchors where (rowSpan === daySpan)
  const getKnown = () => {
    const list = [];
    for (let r = 0; r < numRows; r++) {
      if (rowDays[r] !== null) list.push(r);
    }
    return list;
  };

  let known = getKnown();
  for (let i = 0; i < known.length - 1; i++) {
    const idxA = known[i];
    const idxB = known[i + 1];
    const dayA = rowDays[idxA];
    const dayB = rowDays[idxB];
    const rowSpan = idxB - idxA;
    const daySpan = dayB - dayA;

    if (rowSpan === daySpan && rowSpan > 1) {
      for (let step = 1; step < rowSpan; step++) {
        rowDays[idxA + step] = dayA + step;
      }
    } else if (rowSpan > 1 && daySpan > 0) {
      // Check intermediate rows for valid bounded DATE cell days
      for (let r = idxA + 1; r < idxB; r++) {
        const dp = parseDateColumnText(gridCells[r][COL_DATE]?.text || '', monthNum);
        if (dp.day !== null && dp.day >= dayA && dp.day <= dayB) {
          rowDays[r] = dp.day;
        }
      }
      // Fill remaining within span monotonically
      let cur = dayA;
      for (let r = idxA + 1; r < idxB; r++) {
        if (rowDays[r] !== null) {
          cur = rowDays[r];
        } else {
          const hasDate = (gridCells[r][COL_DATE]?.text || '').trim().length > 0;
          if (hasDate && cur < dayB) cur++;
          rowDays[r] = cur;
        }
      }
    }
  }

  // Pass 3: Fill rows after last known anchor to end of table
  known = getKnown();
  if (known.length > 0) {
    const lastIdx = known[known.length - 1];
    let lastDay = rowDays[lastIdx];
    for (let r = lastIdx + 1; r < numRows; r++) {
      if (rowDays[r] === null) {
        const hasDate = (gridCells[r][COL_DATE]?.text || '').trim().length > 0;
        if (hasDate && lastDay < daysInMonth) lastDay++;
        rowDays[r] = lastDay;
      }
    }
  }

  // Pass 4: Fill any rows before first known anchor
  if (known.length > 0) {
    const firstIdx = known[0];
    let firstDay = rowDays[firstIdx];
    for (let r = firstIdx - 1; r >= 0; r--) {
      if ((gridCells[r][COL_FLIGHT]?.text || '').trim() === 'FLIGHT') continue;
      if (rowDays[r] === null) {
        firstDay = Math.max(1, firstDay - 1);
        rowDays[r] = firstDay;
      }
    }
  }

  return rowDays;
}

/**
 * Guide 5/6: SECTOR parser
 * Handles both 'ICN/NRT' and 'ICNNRT', validates against airports list.
 * Never guesses or substitutes a similar airport code!
 */
export function parseSectorColumnText(raw) {
  if (!raw || !raw.trim()) {
    return { from: '', to: '', fromValid: false, toValid: false, isEmpty: true };
  }
  // Strip trailing punctuation like '.' while preserving letters, digits, '/' and '-'
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9\/\-]/g, '');

  let from = '';
  let to = '';

  const sepMatch = cleaned.match(/^([A-Z0-9]{3})[\/\-]([A-Z0-9]{3})$/);
  if (sepMatch) {
    from = sepMatch[1];
    to = sepMatch[2];
  } else if (/^[A-Z0-9]{6}$/.test(cleaned)) {
    from = cleaned.slice(0, 3);
    to = cleaned.slice(3, 6);
  } else {
    const parts = cleaned.split(/[\/\-]/);
    if (parts.length === 2) {
      from = parts[0].slice(0, 3);
      to = parts[1].slice(0, 3);
    } else {
      from = cleaned.slice(0, 3);
      to = cleaned.slice(3, 6);
    }
  }

  const fromValid = Boolean(from && /^[A-Z]{3}$/.test(from) && getAirport(from));
  const toValid   = Boolean(to && /^[A-Z]{3}$/.test(to) && getAirport(to));

  return {
    from,
    to,
    fromValid,
    toValid,
    isEmpty: false
  };
}

/**
 * Guide 5/6: STD / STA parser
 * Format is 'DD HH:mm'. Even if punctuation is mixed in like '04 04:2.5',
 * if there are EXACTLY 6 digits, interpret as DD (day), HH (hour), mm (minute).
 * If fewer (or more) than 6 digits, do NOT fill arbitrarily — leave blank ('')!
 */
export function parseStdStaColumnText(raw, year, month) {
  if (!raw || !raw.trim()) {
    return { iso: '', valid: false, day: null };
  }

  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 6) {
    return { iso: '', valid: false, day: null };
  }

  const dd = parseInt(digits.slice(0, 2), 10);
  const hh = parseInt(digits.slice(2, 4), 10);
  const mm = parseInt(digits.slice(4, 6), 10);

  if (dd < 1 || dd > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return { iso: '', valid: false, day: null };
  }

  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  return { iso, valid: true, day: dd };
}

/**
 * Determines whether a physical row is a table header, non-flight row (DAY OFF, STBY, layover),
 * or a flight candidate row.
 * Guide 3/6: Exclude day-off/standby/layover rows, but NEVER drop a flight row just because some cells failed!
 */
function classifyTableRow(rowCells) {
  const dateTxt   = (rowCells[COL_DATE]?.text || '').trim();
  const flightTxt = (rowCells[COL_FLIGHT]?.text || '').trim();
  const sectorTxt = (rowCells[COL_SECTOR]?.text || '').trim();
  const stdTxt    = (rowCells[COL_STD]?.text || '').trim();
  const staTxt    = (rowCells[COL_STA]?.text || '').trim();

  if (
    /^DATE$/i.test(dateTxt) ||
    /^FLIGHT$/i.test(flightTxt) ||
    /^SECTOR$/i.test(sectorTxt) ||
    /^STD$/i.test(stdTxt) ||
    /^STA$/i.test(staTxt)
  ) {
    return 'HEADER';
  }

  // User requirement: When FLIGHT contains "STBY" (e.g. "STBY확인요망", "STBY", "STANDBY"), reflect as STBY in schedule
  if (/STBY|STANDBY/i.test(flightTxt)) {
    return 'STBY';
  }

  const hasSectorOrTime = Boolean(sectorTxt || stdTxt || staTxt);

  if (!flightTxt && !hasSectorOrTime) {
    return 'NON_FLIGHT';
  }

  if (!hasSectorOrTime) {
    if (NON_FLIGHT_PATTERNS.some(rx => rx.test(flightTxt))) {
      return 'NON_FLIGHT';
    }
    const cleanFlight = flightTxt.replace(/\s+/g, '').toUpperCase();
    if (/^[A-Z]{3}$/.test(cleanFlight) && getAirport(cleanFlight)) {
      return 'NON_FLIGHT';
    }
  }

  if (NON_FLIGHT_PATTERNS.some(rx => rx.test(flightTxt)) && !hasSectorOrTime) {
    return 'NON_FLIGHT';
  }

  return 'FLIGHT';
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCHEDULE PHOTO RECOGNITION PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recognizes a crew schedule screenshot in the browser.
 * @param {File} file
 * @param {string} targetYearMonth - 'YYYY-MM'
 * @param {Function} onProgress - (progress 0..1, message) => void
 * @returns {Promise<{ flights: Array, detectedYearMonth: string, diagnostics: Object }>}
 */
export async function recognizeSchedulePhoto(file, targetYearMonth, onProgress) {
  if (!file) throw new Error('사진 파일이 선택되지 않았습니다.');
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('파일 크기가 10MB를 초과했습니다.');
  }

  const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!validTypes.includes(file.type)) {
    throw new Error('JPG, PNG, WEBP 형식의 이미지 파일만 지원합니다.');
  }

  const diagnostics = {
    imageWidth: 0,
    imageHeight: 0,
    inputShape: null,
    outputShape: null,
    dictLength: 0,
    horizontalLinesDetected: 0,
    verticalLinesDetected: 0,
    totalRows: 0,
    dataRows: 0,
    totalCells: 0,
    nonEmptyCellsCount: 0,
    recognizedCellsCount: 0,
    usedFallbackTesseract: false,
    cellMatrix: [],
    extractedFlights: []
  };

  const notifyProgress = async (ratio, text) => {
    if (onProgress) {
      try { onProgress(ratio, text); } catch (_) {}
    }
    // Yield to browser UI thread so progress bar repaints smoothly
    await new Promise(r => setTimeout(r, 0));
  };

  await notifyProgress(0.05, 'PaddleOCR 모델 및 런타임 준비 중...');
  const { session, dict } = await loadOCR();
  diagnostics.dictLength = dict.length;

  await notifyProgress(0.15, '사진 픽셀 분석 및 표 영역 검출 중...');
  const { imageData } = await loadImageFromFile(file);
  diagnostics.imageWidth = imageData.width;
  diagnostics.imageHeight = imageData.height;

  // Step 1: Detect horizontal lines & regular row spacing table region
  const tableRegion = detectTableHorizontalLines(imageData);
  if (!tableRegion) {
    // Check if the image has almost no text pixels at all (e.g., blank/empty image)
    let darkCount = 0;
    const totalPixels = imageData.width * imageData.height;
    for (let i = 0; i < imageData.data.length; i += 16) {
      const avg = (imageData.data[i] + imageData.data[i + 1] + imageData.data[i + 2]) / 3;
      if (avg < 200) darkCount++;
    }
    if (darkCount < Math.max(10, (totalPixels / 4) * 0.001)) {
      lastDiagnostics = diagnostics;
      await notifyProgress(1.0, '빈 이미지 — 인식된 비행 없음 (0편)');
      return { flights: [], detectedYearMonth: targetYearMonth, diagnostics };
    }

    diagnostics.usedFallbackTesseract = true;
    lastDiagnostics = diagnostics;
    return await runAuxiliaryTesseractFallback(file, targetYearMonth, onProgress, diagnostics);
  }

  // Step 2: Detect vertical lines for 6 columns (DATE, FLIGHT, SHOWUP, SECTOR, STD, STA)
  const colBounds = detectTableColumns(imageData, tableRegion);
  if (!colBounds || colBounds.length < 7) {
    diagnostics.usedFallbackTesseract = true;
    lastDiagnostics = diagnostics;
    return await runAuxiliaryTesseractFallback(file, targetYearMonth, onProgress, diagnostics);
  }

  const { rowYs } = tableRegion;
  const numRows = rowYs.length - 1;
  const numCols = 6;

  diagnostics.horizontalLinesDetected = rowYs.length;
  diagnostics.verticalLinesDetected = colBounds.length;
  diagnostics.totalRows = numRows;
  diagnostics.totalCells = numRows * numCols;

  // Step 3: Recognize cells across physical rows using whole-table batching
  const gridCells = [];
  let monthDetectedFromDate = false;

  const emptyCellObj = (isEmpty = true) => ({
    text: '',
    avgScore: 1.0,
    isEmpty,
    candidateDisagreement: false,
    needsCheck: false,
    candidates: []
  });

  // Pre-scan all rows and build row-level metadata
  const rowMetadata = [];
  for (let r = 0; r < numRows; r++) {
    const y1 = rowYs[r];
    const y2 = rowYs[r + 1];
    const bboxes = [];
    for (let c = 0; c < numCols; c++) {
      const info = inspectCellBBox(imageData, colBounds[c], y1, colBounds[c + 1], y2, 200);
      if (!info.isEmpty) diagnostics.nonEmptyCellsCount++;
      bboxes.push(info);
    }
    const hasRightSideData = !bboxes[COL_SECTOR].isEmpty || !bboxes[COL_STD].isEmpty || !bboxes[COL_STA].isEmpty;
    const hasFlightText = !bboxes[COL_FLIGHT].isEmpty;
    const isFlightCandidate = hasRightSideData || bboxes[COL_FLIGHT].hasBluePixels || hasFlightText;
    rowMetadata.push({
      r,
      y1,
      y2,
      bboxes,
      hasRightSideData,
      isFlightCandidate,
      isHeader: false,
      stdHeadCell: null
    });
  }

  // Fast header check on row 0
  if (rowMetadata.length > 0 && !rowMetadata[0].bboxes[COL_STD].isEmpty) {
    const stdHeadCell = await recognizeTableCell(
      session, dict, imageData,
      colBounds[COL_STD], rowMetadata[0].y1, colBounds[COL_STD + 1], rowMetadata[0].y2,
      COL_STD, diagnostics, false, rowMetadata[0].bboxes[COL_STD]
    );
    if (/^(STD|STA)$/i.test((stdHeadCell.text || '').trim())) {
      rowMetadata[0].isHeader = true;
      rowMetadata[0].stdHeadCell = stdHeadCell;
    }
  }

  // Queue candidate cells across active rows
  const queue = [];
  for (const meta of rowMetadata) {
    if (meta.isHeader) continue;
    const { r, y1, y2, bboxes } = meta;
    const colsToQueue = [];

    // Read DATE column on rows 0..4 (to detect month) and rows with right-side data (flights)
    // Non-flight rows are solved mathematically by resolveTableCalendarDays, saving 25+ unnecessary OCR runs
    if (!bboxes[COL_DATE].isEmpty && (r <= 4 || meta.hasRightSideData)) {
      colsToQueue.push(COL_DATE);
    }

    // Read FLIGHT column if present
    if (!bboxes[COL_FLIGHT].isEmpty) {
      colsToQueue.push(COL_FLIGHT);
    }

    // Read SECTOR, STD, STA if right side data exists
    if (meta.hasRightSideData) {
      colsToQueue.push(COL_SECTOR, COL_STD, COL_STA);
    }

    for (const c of colsToQueue) {
      const prep = buildCellInputTensor(imageData, colBounds[c], y1, colBounds[c + 1], y2, {
        marginPx: 1,
        mode: 'rgb',
        bboxInfo: bboxes[c]
      });
      if (!prep.isEmpty && prep.tensor) {
        queue.push({ r, c, tensor: prep.tensor });
      }
    }
  }

  // Execute global batch in chunks of 32
  const primaryResultsMap = new Map();
  const CHUNK_SIZE = 32;
  const totalChunks = Math.max(1, Math.ceil(queue.length / CHUNK_SIZE));
  for (let i = 0; i < queue.length; i += CHUNK_SIZE) {
    const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
    const ratio = 0.2 + ((chunkNum - 1) / totalChunks) * 0.68;
    await notifyProgress(ratio, `표 비행 데이터 분석 중 (${Math.round(((chunkNum - 1) / totalChunks) * 100)}%)...`);

    const chunk = queue.slice(i, i + CHUNK_SIZE);
    const tensors = chunk.map(item => item.tensor);
    const results = await runBatchInference(session, dict, tensors, diagnostics);
    for (let k = 0; k < chunk.length; k++) {
      primaryResultsMap.set(`${chunk[k].r}_${chunk[k].c}`, results[k]);
    }

    const endRatio = 0.2 + (chunkNum / totalChunks) * 0.68;
    await notifyProgress(endRatio, `표 비행 데이터 분석 중 (${Math.round((chunkNum / totalChunks) * 100)}%)...`);
  }

  // Distribute results & perform selective verification / retries
  for (let r = 0; r < numRows; r++) {
    const meta = rowMetadata[r];
    const { y1, y2, bboxes, isHeader, stdHeadCell } = meta;
    const rowArr = new Array(numCols);
    for (let c = 0; c < numCols; c++) {
      rowArr[c] = emptyCellObj(bboxes[c].isEmpty);
    }

    if (isHeader) {
      rowArr[COL_STD] = stdHeadCell;
      rowArr[COL_FLIGHT] = { ...emptyCellObj(false), text: 'FLIGHT' };
      gridCells.push(rowArr);
      diagnostics.cellMatrix.push({
        rowIndex: r,
        yRange: [y1, y2],
        cells: rowArr.map(c => ({ text: c.text, score: Number(c.avgScore.toFixed(4)), disagree: c.candidateDisagreement }))
      });
      continue;
    }

    // Always populate DATE cell from primary batch
    if (!bboxes[COL_DATE].isEmpty) {
      const datePrimary = primaryResultsMap.get(`${r}_${COL_DATE}`) || null;
      if (datePrimary) {
        rowArr[COL_DATE] = {
          text: datePrimary.text,
          avgScore: datePrimary.avgScore,
          isEmpty: false,
          candidateDisagreement: false,
          needsCheck: false,
          candidates: [{ label: 'rgb_m1', ...datePrimary }]
        };
        diagnostics.recognizedCellsCount++;
        const dp = parseDateColumnText(datePrimary.text);
        if (dp.month !== null) monthDetectedFromDate = true;
      }
    }

    // Populate FLIGHT cell
    const fltPrimary = primaryResultsMap.get(`${r}_${COL_FLIGHT}`) || null;
    if (fltPrimary) {
      rowArr[COL_FLIGHT] = await recognizeTableCell(
        session, dict, imageData,
        colBounds[COL_FLIGHT], y1, colBounds[COL_FLIGHT + 1], y2,
        COL_FLIGHT, diagnostics, true, bboxes[COL_FLIGHT], fltPrimary
      );
      if (!rowArr[COL_FLIGHT].isEmpty) diagnostics.recognizedCellsCount++;
    }

    const fltTxt = (rowArr[COL_FLIGHT].text || '').trim();
    const isSTBY = /STBY|STANDBY/i.test(fltTxt);
    if (isSTBY) {
      rowArr[COL_FLIGHT].text = 'STBY';
    }

    const isClearlyNonFlight =
      !meta.hasRightSideData &&
      !isSTBY &&
      (
        !fltTxt ||
        NON_FLIGHT_PATTERNS.some(rx => rx.test(fltTxt)) ||
        (/^[A-Z]{3}$/i.test(fltTxt.replace(/\s+/g, '')) && Boolean(getAirport(fltTxt.replace(/\s+/g, ''))))
      );

    if (!isClearlyNonFlight) {
      for (const c of [COL_SECTOR, COL_STD, COL_STA]) {
        if (bboxes[c].isEmpty) continue;
        const cellPrimary = primaryResultsMap.get(`${r}_${c}`) || null;
        rowArr[c] = await recognizeTableCell(
          session, dict, imageData,
          colBounds[c], y1, colBounds[c + 1], y2,
          c, diagnostics, true, bboxes[c], cellPrimary
        );
        if (!rowArr[c].isEmpty) diagnostics.recognizedCellsCount++;
      }
    }

    gridCells.push(rowArr);
    diagnostics.cellMatrix.push({
      rowIndex: r,
      yRange: [y1, y2],
      cells: rowArr.map(c => ({
        text: c.text,
        score: Number(c.avgScore.toFixed(4)),
        disagree: c.candidateDisagreement
      }))
    });
  }

  // Step 4: Detect year & month from header above table + DATE column
  await notifyProgress(0.90, '연월 및 비행 데이터 검증 중...');
  const dateTexts = gridCells.map(r => r[COL_DATE]?.text || '');
  const detectedYearMonth = await detectYearMonthFromHeaderAndDates(
    session,
    dict,
    imageData,
    tableRegion,
    dateTexts,
    targetYearMonth,
    diagnostics
  );
  const [yearNum, monthNum] = detectedYearMonth.split('-').map(Number);

  // Step 5: Link physical rows -> Flight objects
  const flights = [];
  let dataRowCount = 0;
  let activeDateDay = null;
  const resolvedRowDays = resolveTableCalendarDays(gridCells, yearNum, monthNum);

  for (let r = 0; r < gridCells.length; r++) {
    const rowCells = gridCells[r];
    const rowType = classifyTableRow(rowCells);
    if (rowType === 'HEADER') continue;
    dataRowCount++;

    const rowDay = resolvedRowDays[r] || 1;
    activeDateDay = rowDay;

    if (rowType === 'NON_FLIGHT') continue;

    // Physical row is a FLIGHT candidate (Guide 3/6: never discard incomplete flight rows)
    const fltCell = rowCells[COL_FLIGHT];
    const secCell = rowCells[COL_SECTOR];
    const stdCell = rowCells[COL_STD];
    const staCell = rowCells[COL_STA];

    const rawFlightText = (fltCell?.text || '').trim().toUpperCase().replace(/\s+/g, '');
    const isSTBY = rowType === 'STBY' || /STBY|STANDBY/i.test(rawFlightText);
    const flightNumber = isSTBY ? 'STBY' : rawFlightText.replace(/[^A-Z0-9]/g, '');

    const sectorParsed = parseSectorColumnText(secCell?.text || '');
    let fromCode = sectorParsed.from;
    let toCode = sectorParsed.to;
    if (isSTBY) {
      if (!fromCode) fromCode = 'ICN';
      if (!toCode) toCode = fromCode;
    }

    const stdParsed = parseStdStaColumnText(stdCell?.text || '', yearNum, monthNum);
    const staParsed = parseStdStaColumnText(staCell?.text || '', yearNum, monthNum);

    let depIso = stdParsed.iso;
    let arrIso = staParsed.iso;
    if (isSTBY) {
      const dayNum = rowDay;
      const dayStr = String(dayNum).padStart(2, '0');
      const monthStr = String(monthNum).padStart(2, '0');
      depIso = `${yearNum}-${monthStr}-${dayStr}T09:00`;
      arrIso = `${yearNum}-${monthStr}-${dayStr}T18:00`;
    }

    // Validate chronological order & timezone (Guide 5/6)
    // Check both local airport timezone and Korea timezone (since transpacific flights like ICN->SFO
    // can arrive earlier in local clock time on the same date, e.g., 01 21:00 KST -> 01 15:30 PDT).
    let timeOrderInvalid = false;
    if (!isSTBY && stdParsed.valid && staParsed.valid && sectorParsed.fromValid && sectorParsed.toValid) {
      const depLocal = parseFlightTime(stdParsed.iso, sectorParsed.from, 'local');
      const arrLocal = parseFlightTime(staParsed.iso, sectorParsed.to, 'local');
      const depKorea = parseFlightTime(stdParsed.iso, sectorParsed.from, 'korea');
      const arrKorea = parseFlightTime(staParsed.iso, sectorParsed.to, 'korea');

      const validInLocal =
        depLocal?.date && arrLocal?.date && !depLocal.error && !arrLocal.error &&
        arrLocal.date.getTime() > depLocal.date.getTime();
      const validInKorea =
        depKorea?.date && arrKorea?.date && !depKorea.error && !arrKorea.error &&
        arrKorea.date.getTime() > depKorea.date.getTime();

      if (!validInLocal && !validInKorea) {
        timeOrderInvalid = true;
      }
    }

    // Guide 6/6: Flag uncertainties (< 0.95 score, candidate disagreement, airport validation failure, missing date/time)
    const uncertainNumber = isSTBY ? false : (
      !flightNumber ||
      !/^([A-Z]{2})?\d{3,4}[A-Z]?$/.test(flightNumber) ||
      fltCell.avgScore < SCORE_THRESHOLD ||
      fltCell.candidateDisagreement
    );

    const uncertainFrom = isSTBY ? false : (
      !sectorParsed.from ||
      !sectorParsed.fromValid ||
      secCell.avgScore < SCORE_THRESHOLD ||
      secCell.candidateDisagreement
    );

    const uncertainTo = isSTBY ? false : (
      !sectorParsed.to ||
      !sectorParsed.toValid ||
      secCell.avgScore < SCORE_THRESHOLD ||
      secCell.candidateDisagreement
    );

    const uncertainDep = isSTBY ? false : (
      !stdParsed.valid ||
      stdCell.avgScore < SCORE_THRESHOLD ||
      stdCell.candidateDisagreement ||
      timeOrderInvalid
    );

    const uncertainArr = isSTBY ? false : (
      !staParsed.valid ||
      staCell.avgScore < SCORE_THRESHOLD ||
      staCell.candidateDisagreement ||
      timeOrderInvalid
    );

    const flightObj = {
      number: flightNumber,
      from: fromCode,
      to: toCode,
      departure: depIso,
      arrival: arrIso,
      isUncertain: {
        number: uncertainNumber,
        from: uncertainFrom,
        to: uncertainTo,
        departure: uncertainDep,
        arrival: uncertainArr
      },
      _ocrMeta: {
        physicalRow: r,
        mergedDateDay: activeDateDay,
        rawDate: rowCells[COL_DATE]?.text || '',
        rawFlight: fltCell?.text || '',
        rawShowup: rowCells[COL_SHOWUP]?.text || '',
        rawSector: secCell?.text || '',
        rawStd: stdCell?.text || '',
        rawSta: staCell?.text || '',
        scores: {
          flight: Number((fltCell?.avgScore || 0).toFixed(4)),
          sector: Number((secCell?.avgScore || 0).toFixed(4)),
          std: Number((stdCell?.avgScore || 0).toFixed(4)),
          sta: Number((staCell?.avgScore || 0).toFixed(4))
        },
        disagreement: {
          flight: fltCell?.candidateDisagreement || false,
          sector: secCell?.candidateDisagreement || false,
          std: stdCell?.candidateDisagreement || false,
          sta: staCell?.candidateDisagreement || false
        },
        candidates: {
          flight: fltCell?.candidates || [],
          sector: secCell?.candidates || [],
          std: stdCell?.candidates || [],
          sta: staCell?.candidates || []
        }
      }
    };

    flights.push(flightObj);
    diagnostics.extractedFlights.push(flightObj);
  }

  // Post-validation: STBY cannot overlap with active flight duty dates
  const flightActiveDates = new Set();
  for (const f of flights) {
    if (f.number !== 'STBY') {
      if (f.departure) flightActiveDates.add(f.departure.slice(0, 10));
      if (f.arrival) flightActiveDates.add(f.arrival.slice(0, 10));
    }
  }

  for (const f of flights) {
    if (f.number === 'STBY' && f.departure) {
      const stbyDate = f.departure.slice(0, 10);
      if (flightActiveDates.has(stbyDate)) {
        f.isUncertain.departure = true;
        f.isUncertain.arrival = true;
        diagnostics.needsManualReview = true;
        console.warn(`[OCR Validation] STBY date conflict on ${stbyDate} with active flight schedule.`);
      }
    }
  }

  diagnostics.dataRows = dataRowCount;
  lastDiagnostics = diagnostics;

  await notifyProgress(1.0, `표 셀 분리 및 인식 완료 (${flights.length}편 추출)`);

  return {
    flights,
    detectedYearMonth,
    diagnostics
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUXILIARY TESSERACT FALLBACK (Guide 6/6: used ONLY when table grid is absent)
// ─────────────────────────────────────────────────────────────────────────────
let tesseractPromise = null;

function loadAuxiliaryTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractPromise) return tesseractPromise;

  tesseractPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.async = true;
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return tesseractPromise;
}

async function runAuxiliaryTesseractFallback(file, targetYearMonth, onProgress, diagnostics) {
  if (onProgress) onProgress(0.45, '표 격자 미검출 — 보조 OCR(Tesseract) 시도 중...');
  const Tesseract = await loadAuxiliaryTesseract();
  if (!Tesseract) {
    return { flights: [], detectedYearMonth: targetYearMonth, diagnostics };
  }

  const worker = await Tesseract.createWorker(['eng', 'kor']);
  try {
    const url = URL.createObjectURL(file);
    const ret = await worker.recognize(url);
    URL.revokeObjectURL(url);
    await worker.terminate();

    const rawText = ret.data?.text || '';
    let detectedYearMonth = targetYearMonth;
    const ymMatch = rawText.match(/(20\d{2})\s*년\s*(0?[1-9]|1[0-2])\s*월/);
    if (ymMatch) {
      detectedYearMonth = `${ymMatch[1]}-${String(ymMatch[2]).padStart(2, '0')}`;
    }

    const flights = parseScheduleText(rawText, detectedYearMonth);
    for (const f of flights) {
      f.isUncertain = { number: true, from: true, to: true, departure: true, arrival: true };
    }
    diagnostics.extractedFlights = flights;
    if (onProgress) onProgress(1.0, `보조 인식 완료 (${flights.length}편)`);
    return { flights, detectedYearMonth, diagnostics };
  } catch (_) {
    try { await worker.terminate(); } catch (_e) {}
    return { flights: [], detectedYearMonth: targetYearMonth, diagnostics };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT PASTE PARSER (For manual text paste tool)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses schedule text pasted by the user or from auxiliary fallback.
 * Never fabricates or returns sample schedules.
 */
export function parseScheduleText(rawText, targetYearMonth) {
  if (!rawText || !rawText.trim()) return [];

  let [yearStr, monthStr] = (targetYearMonth || '2026-10').split('-');
  let year = parseInt(yearStr, 10) || new Date().getFullYear();
  let month = parseInt(monthStr, 10) || (new Date().getMonth() + 1);

  const ymMatch = rawText.match(/(20\d{2})\s*[년\-\/\.]\s*(0?[1-9]|1[0-2])/);
  if (ymMatch) {
    year = parseInt(ymMatch[1], 10);
    if (ymMatch[2]) month = parseInt(ymMatch[2], 10);
  }

  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const flights = [];

  for (const line of lines) {
    if (/^(DATE|FLIGHT|SHOWUP|SECTOR|STD|STA|날짜|편명)/i.test(line)) continue;

    // Support STBY lines (e.g. "11/15 STBY확인요망" or "STBY")
    if (/STBY|STANDBY/i.test(line)) {
      const dateMatch = line.match(/\b(?:(0?[1-9]|1[0-2])\s*[\/\-]\s*)?(0?[1-9]|[12]\d|3[01])\b/);
      const day = dateMatch ? parseInt(dateMatch[2] || dateMatch[1], 10) : 1;
      const dayStr = String(day).padStart(2, '0');
      const monthStr = String(month).padStart(2, '0');
      flights.push({
        number: 'STBY',
        from: 'ICN',
        to: 'ICN',
        departure: `${year}-${monthStr}-${dayStr}T09:00`,
        arrival: `${year}-${monthStr}-${dayStr}T18:00`,
        isUncertain: {
          number: false,
          from: false,
          to: false,
          departure: false,
          arrival: false
        }
      });
      continue;
    }

    if (NON_FLIGHT_PATTERNS.some(rx => rx.test(line))) continue;

    // Remove SHOWUP pattern (e.g., T1 01 19:10 or T2 17 12:05)
    const withoutShowup = line.replace(/\bT[12]\s+\d{1,2}\s+\d{2}:\d{2}\b/gi, ' ');
    // Remove date column prefix (e.g., 10/01(목))
    const withoutDateCol = withoutShowup.replace(/\b\d{1,2}\s*\/\s*\d{1,2}\s*(\([^\)]*\))?/g, ' ');

    // Sector match: ICN/SFO or ICNNRT
    const sectorMatch = withoutDateCol.match(/\b([A-Z]{3})\s*[\/\-]\s*([A-Z]{3})\b|\b([A-Z]{6})\b/);
    if (!sectorMatch) continue;

    let from = '', to = '';
    if (sectorMatch[1] && sectorMatch[2]) {
      from = sectorMatch[1];
      to = sectorMatch[2];
    } else if (sectorMatch[3]) {
      from = sectorMatch[3].slice(0, 3);
      to = sectorMatch[3].slice(3, 6);
    }

    const beforeSector = withoutDateCol.slice(0, sectorMatch.index).trim();
    const fltMatch = beforeSector.match(/\b([A-Z]{2}\s*\d{2,4}[A-Z]?|\d{3,4}[A-Z]?)\b/i);
    const flightNumber = fltMatch ? fltMatch[1].replace(/\s+/g, '').toUpperCase() : '';

    const afterSector = withoutDateCol.slice(sectorMatch.index + sectorMatch[0].length).trim();
    const timeTokens = [...afterSector.matchAll(/(\d{2})\s+(\d{2})[:\.](\d{2})/g)];

    let departure = '';
    let arrival = '';
    if (timeTokens.length >= 1) {
      const t1 = timeTokens[0];
      const stdParsed = parseStdStaColumnText(`${t1[1]} ${t1[2]}:${t1[3]}`, year, month);
      departure = stdParsed.iso;
    }
    if (timeTokens.length >= 2) {
      const t2 = timeTokens[1];
      const staParsed = parseStdStaColumnText(`${t2[1]} ${t2[2]}:${t2[3]}`, year, month);
      arrival = staParsed.iso;
    }

    const fromValid = Boolean(from && getAirport(from));
    const toValid   = Boolean(to && getAirport(to));

    flights.push({
      number: flightNumber,
      from,
      to,
      departure,
      arrival,
      isUncertain: {
        number: !flightNumber,
        from: !fromValid,
        to: !toValid,
        departure: !departure,
        arrival: !arrival
      }
    });
  }

  return flights;
}

/**
 * Guide 6/6: Hardcoding sample data or returning sample schedule as OCR result is strictly forbidden.
 */
export function getSampleSchedule() {
  return [];
}
