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
  /DAY\s*OF[FE]/i,
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

  // Recover trailing bottom border row if anti-aliased against white background below the table (avg <= 248)
  const lastY = rowYs[rowYs.length - 1];
  const expectedNextY = Math.round(lastY + medianGap);
  if (expectedNextY < height - 2) {
    let bestTrailY = -1;
    let bestTrailCount = 0;
    for (let sy = Math.max(lastY + 6, expectedNextY - 3); sy <= Math.min(height - 1, expectedNextY + 3); sy++) {
      let lightGrayCount = 0;
      for (let x = xMargin; x < width - xMargin; x++) {
        const idx = (sy * width + x) * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const avg = (r + g + b) / 3;
        const diff = Math.max(r, g, b) - Math.min(r, g, b);
        if (avg >= 145 && avg <= 248 && diff <= 24) {
          lightGrayCount++;
        }
      }
      if (lightGrayCount > bestTrailCount) {
        bestTrailCount = lightGrayCount;
        bestTrailY = sy;
      }
    }
    if (bestTrailY > lastY && bestTrailCount >= scanW * 0.75) {
      rowYs.push(bestTrailY);
    }
  }

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
 * Also handles screenshots where the outer left border (x ≈ 0) or outer right border (x ≈ width - 1)
 * is cropped off at the viewport edge.
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

  // When outer left border of DATE or outer right border of STA is cropped off at the screenshot edge
  if (filtered.length === 6) {
    const xs = filtered.map(l => l.x);
    if (xs[0] >= width * 0.08 && xs[5] >= width * 0.88) {
      return [0, ...xs];
    }
    if (xs[0] < width * 0.08 && xs[5] <= width * 0.92) {
      return [...xs, width - 1];
    }
  } else if (filtered.length === 5) {
    const xs = filtered.map(l => l.x);
    if (xs[0] >= width * 0.08 && xs[4] <= width * 0.92) {
      return [0, ...xs, width - 1];
    }
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
  const { marginPx = 1, mode = 'rgb', bboxInfo = null, threshold = 200, colIdx = null } = options;
  const info = bboxInfo || inspectCellBBox(srcImageData, x1, y1, x2, y2, threshold);
  if (info.isEmpty) {
    return { tensor: null, isEmpty: true, hasBluePixels: false };
  }

  const { data, width } = srcImageData;
  const { cx1, cy1, cw, ch, minX, maxX, minY, maxY, hasBluePixels } = info;

  // Guide 4/6: Add ~1px margin (or 0/1/2px on retry) in original coordinates.
  // For low-resolution SECTOR cells (raw text height <= 9px), preserve >= 3px vertical margin
  // so top/bottom serifs on 'I' (e.g. ICN/FUK) do not touch the 48px canvas border and resemble 'H'.
  const rawH = maxY - minY + 1;
  const marginY = (colIdx === COL_SECTOR && rawH <= 9) ? Math.max(marginPx, 3) : marginPx;
  const bx1 = Math.max(0, minX - marginPx);
  const by1 = Math.max(0, minY - marginY);
  const bx2 = Math.min(cw - 1, maxX + marginPx);
  const by2 = Math.min(ch - 1, maxY + marginY);

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
    if (digits.length !== 6) return false;
    const dd = parseInt(digits.slice(0, 2), 10);
    const hh = parseInt(digits.slice(2, 4), 10);
    const mm = parseInt(digits.slice(4, 6), 10);
    return dd >= 1 && dd <= 31 && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
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
    const basePrep = buildCellInputTensor(imageData, x1, y1, x2, y2, { marginPx: 1, mode: 'rgb', bboxInfo, colIdx });
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
        const widePrep = buildCellInputTensor(imageData, x1, y1, x2, y2, { marginPx: 2, mode: 'rgb', bboxInfo: wideBBox, threshold: 215, colIdx });
        if (!widePrep.isEmpty) {
          const wideRes = await runSingleInference(session, dict, widePrep.tensor, diagnosticsSink);
          if (wideRes.text) candidates.push({ label: 'rgb_m2_t215', ...wideRes });
        }
      }
    }

    if (!candidates.some(c => isCellFormatClean(c.text, colIdx))) {
      const prepM2 = buildCellInputTensor(imageData, x1, y1, x2, y2, { marginPx: 2, mode: 'rgb', bboxInfo, colIdx });
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
        const prep = buildCellInputTensor(imageData, x1, y1, x2, y2, { ...cfg, bboxInfo, colIdx });
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

    for (const [by1, by2] of textBands) {
      if (detectedYear && detectedMonth) break;
      const prep = buildCellInputTensor(imageData, 0, by1, Math.round(width * 0.30), by2, { marginPx: 1, mode: 'rgb' });
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

    // Check if flight at idxA is an overnight flight arriving on staDay > dayA (e.g. departs 09 23:55, arrives 10 06:55)
    const staParsedA = parseStdStaColumnText(gridCells[idxA][COL_STA]?.text || '', yearNum, monthNum);
    const effectiveEndDayA = (staParsedA.valid && staParsedA.day && staParsedA.day > dayA && staParsedA.day < dayB)
      ? staParsedA.day
      : dayA;

    if (rowSpan === daySpan && rowSpan > 1) {
      for (let step = 1; step < rowSpan; step++) {
        rowDays[idxA + step] = dayA + step;
      }
    } else if (effectiveEndDayA > dayA && rowSpan === (dayB - effectiveEndDayA) && rowSpan > 1) {
      for (let step = 1; step < rowSpan; step++) {
        rowDays[idxA + step] = effectiveEndDayA + step;
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

    // Read DATE column on all non-empty rows in the batched inference pass so STBY/off rows have exact date anchors
    if (!bboxes[COL_DATE].isEmpty) {
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
        bboxInfo: bboxes[c],
        colIdx: c
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

// ─────────────────────────────────────────────────────────────────────────────
// KOREAN AIR NEW MOBILE SCHEDULE (HANWAY Crewnet) RECOGNITION
//
// Layout facts (all measured as fractions of image width so any phone resolution works):
//  - date column  : x 0.07w ~ 0.25w   (month / BIG day number / weekday)
//  - schedule card: x 0.27w ~ 0.87w   (tinted background, rounded)
//  - card text    : x 0.297w ~ 0.78w  (line1 = code, line2 = sector / times); chevron at 0.79w+
// Each card is cropped tightly per text line and recognised at its natural width
// (the PaddleOCR rec model has a dynamic width axis), so wide lines such as
// "ICN -KIX / 16:40 - 18:30" are never squeezed into 320px.
// ─────────────────────────────────────────────────────────────────────────────

const KAL_PAD_VAL = 128 / 127.5 - 1;
const KAL_MAX_W = 1280;

function kalNonWhite(data, width, x, y) {
  const i = (y * width + x) * 4;
  return (765 - data[i] - data[i + 1] - data[i + 2]) >= 12;
}

function kalNonWhiteFraction(data, width, x1, x2, y1, y2) {
  let hit = 0;
  let total = 0;
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      total++;
      if (kalNonWhite(data, width, x, y)) hit++;
    }
  }
  return total ? hit / total : 0;
}

/**
 * Finds every tinted schedule card by sampling the empty left padding of the card column
 * (no text lives there), which is independent of the card colour (blue / yellow / grey).
 */
function detectKalCards(imageData) {
  const { data, width, height } = imageData;
  const sx1 = Math.round(width * 0.275);
  const sx2 = Math.round(width * 0.297);
  const n = Math.max(1, sx2 - sx1);

  const inCard = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = sx1; x < sx2; x++) {
      const i = (y * width + x) * 4;
      dark += 765 - data[i] - data[i + 1] - data[i + 2];
    }
    inCard[y] = (dark / n) >= 12 ? 1 : 0;
  }
  // close 1-2px JPEG holes
  for (let y = 1; y < height - 2; y++) {
    if (!inCard[y] && inCard[y - 1] && (inCard[y + 1] || inCard[y + 2])) inCard[y] = 1;
  }

  const minH = Math.round(width * 0.075);
  const cards = [];
  let start = -1;
  for (let y = 0; y <= height; y++) {
    const on = y < height && inCard[y];
    if (on && start === -1) {
      start = y;
    } else if (!on && start !== -1) {
      const y1 = start;
      const y2 = y;
      start = -1;
      if (y2 - y1 < minH) continue;

      // Validate shape at vertical midpoint: white gap just left/right of card, tinted interior.
      const midY = (y1 + y2) >> 1;
      const ty1 = Math.max(0, midY - 3);
      const ty2 = Math.min(height - 1, midY + 3);
      const justLeftFrac = kalNonWhiteFraction(data, width, Math.round(width * 0.235), Math.round(width * 0.262), ty1, ty2);
      const cardMidFrac = kalNonWhiteFraction(data, width, Math.round(width * 0.30), Math.round(width * 0.84), ty1, ty2);
      const farRightFrac = kalNonWhiteFraction(data, width, Math.round(width * 0.89), Math.round(width * 0.96), ty1, ty2);
      if (justLeftFrac > 0.25 || cardMidFrac < 0.8 || farRightFrac > 0.25) continue;

      // Card background colour from the empty left padding, vertically centred.
      const bx = Math.round(width * 0.285);
      const by = Math.min(height - 1, y1 + Math.round((y2 - y1) / 2));
      const bi = (by * width + bx) * 4;
      cards.push({
        y1,
        y2,
        bg: [data[bi], data[bi + 1], data[bi + 2]]
      });
    }
  }
  return cards;
}

/** Vertical bands (text lines) whose pixels differ from `bg` by more than `thr` (sum of |dRGB|). */
function kalFindBands(imageData, x1, y1, x2, y2, bg, thr, minH) {
  const { data, width, height } = imageData;
  const yy1 = Math.max(0, y1);
  const yy2 = Math.min(height, y2);
  const bands = [];
  let start = -1;
  for (let y = yy1; y < yy2; y++) {
    let ink = false;
    for (let x = x1; x < x2; x++) {
      const i = (y * width + x) * 4;
      const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (d > thr) { ink = true; break; }
    }
    if (ink && start === -1) {
      start = y;
    } else if (!ink && start !== -1) {
      if (y - start >= minH) bands.push({ y1: start, y2: y, h: y - start });
      start = -1;
    }
  }
  if (start !== -1 && yy2 - start >= minH) bands.push({ y1: start, y2: yy2, h: yy2 - start });
  return bands;
}

/** Tight bounding box of ink inside a region (+pad). Returns null if empty. */
function kalTightBox(imageData, x1, y1, x2, y2, bg, thr, pad) {
  const { data, width, height } = imageData;
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (let y = Math.max(0, y1); y < Math.min(height, y2); y++) {
    for (let x = x1; x < x2; x++) {
      const i = (y * width + x) * 4;
      const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (d > thr) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    x1: Math.max(0, minX - pad),
    y1: Math.max(0, minY - pad),
    x2: Math.min(width, maxX + 1 + pad),
    y2: Math.min(height, maxY + 1 + pad)
  };
}

let kalScaleCanvas = null;
let kalScaleCtx = null;

/** Crops a box from the source canvas and scales it to height 48 (natural width, <= KAL_MAX_W). */
function kalBuildLineTensor(srcCanvas, box) {
  const sw = box.x2 - box.x1;
  const sh = box.y2 - box.y1;
  if (sw <= 0 || sh <= 0) return null;
  const tw = Math.max(8, Math.min(KAL_MAX_W, Math.round(sw * (INPUT_H / sh))));

  if (!kalScaleCanvas) {
    kalScaleCanvas = document.createElement('canvas');
    kalScaleCtx = kalScaleCanvas.getContext('2d', { willReadFrequently: true });
  }
  kalScaleCanvas.width = tw;
  kalScaleCanvas.height = INPUT_H;
  kalScaleCtx.fillStyle = 'rgb(128, 128, 128)';
  kalScaleCtx.fillRect(0, 0, tw, INPUT_H);
  kalScaleCtx.imageSmoothingEnabled = true;
  kalScaleCtx.imageSmoothingQuality = 'high';
  kalScaleCtx.drawImage(srcCanvas, box.x1, box.y1, sw, sh, 0, 0, tw, INPUT_H);

  const px = kalScaleCtx.getImageData(0, 0, tw, INPUT_H).data;
  const plane = INPUT_H * tw;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const p = i * 4;
    data[i] = px[p] / 127.5 - 1;
    data[plane + i] = px[p + 1] / 127.5 - 1;
    data[2 * plane + i] = px[p + 2] / 127.5 - 1;
  }
  return { data, w: tw };
}

/**
 * Batched variable-width recognition. Items are grouped by width, padded with neutral grey
 * to the widest item of each chunk (CTC ignores padding) and decoded one by one.
 * @returns {Promise<string[]>} texts in the same order as `items`
 */
async function kalRecognizeLines(session, dict, items) {
  const ort = window.ort;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const order = items.map((_, i) => i).sort((a, b) => items[a].w - items[b].w);
  const texts = new Array(items.length).fill('');
  const CHUNK = 12;

  for (let s = 0; s < order.length; s += CHUNK) {
    const idxs = order.slice(s, s + CHUNK);
    const maxW = Math.max(64, Math.ceil(Math.max(...idxs.map(i => items[i].w)) / 32) * 32);
    const B = idxs.length;
    const plane = INPUT_H * maxW;
    const batch = new Float32Array(B * 3 * plane).fill(KAL_PAD_VAL);

    idxs.forEach((itemIdx, b) => {
      const it = items[itemIdx];
      const itPlane = INPUT_H * it.w;
      for (let c = 0; c < 3; c++) {
        for (let y = 0; y < INPUT_H; y++) {
          const srcOff = c * itPlane + y * it.w;
          const dstOff = b * 3 * plane + c * plane + y * maxW;
          batch.set(it.data.subarray(srcOff, srcOff + it.w), dstOff);
        }
      }
    });

    const out = (await session.run({ [inputName]: new ort.Tensor('float32', batch, [B, 3, INPUT_H, maxW]) }))[outputName];
    const T = out.dims[1];
    const C = out.dims[2];
    if (dict.length !== C) {
      throw new Error(`사전 크기(${dict.length})와 모델 출력 클래스 수(${C})가 일치하지 않습니다.`);
    }
    idxs.forEach((itemIdx, b) => {
      texts[itemIdx] = decodeCTC(out.data.subarray(b * T * C, (b + 1) * T * C), T, C, dict).text;
    });
  }
  return texts;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Line 1: "KE 114Z" | "T_DO" | "T_NDUTY" | "LO" | "ADO" | "ATDO" | "STBY" | "T_STBY" ... */
function parseKalCode(text) {
  const norm = (text || '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  if (!norm) return { kind: 'EMPTY' };
  if (/STBY|STANDBY|STBI/.test(norm)) return { kind: 'STBY' };
  if (/NDUTY|ADO|ATDO|T_?DO|^DO$|^LO$/.test(norm)) return { kind: 'OTHER', code: norm };
  const m = norm.match(/^([A-Z0-9]{2})([0-9OIL]{2,4})([A-Z]?)$/);
  if (m && /^(?:[A-Z]{2}|[A-Z][0-9]|[0-9][A-Z])$/.test(m[1])) {
    const digits = m[2].replace(/O/g, '0').replace(/[IL]/g, '1');
    return { kind: 'FLIGHT', number: `${m[1]}${digits}${m[3]}` };
  }
  return { kind: 'OTHER', code: norm };
}

/**
 * Line 2: "ICN -KIX / 16:40 - 18:30" | "ICN -SYD / 20:00 -" | "ICN -SYD / - 08:20" |
 *         "LAX -ICN / -" | "GMP- 15:50- HND 17:50" | "ICN 09:00 - 19:00"
 */
function parseKalSector(text) {
  const raw = (text || '').toUpperCase().trim();
  const result = { from: '', to: '', dep: null, arr: null, timeOk: true };
  if (!raw) return { ...result, timeOk: false };

  let rest = '';
  const m1 = raw.match(/([A-Z]{3})\s*-\s*([A-Z]{3})([\s\S]*)/);
  if (m1) {
    result.from = m1[1];
    result.to = m1[2];
    rest = m1[3];
  } else {
    // 2-line wrapped cell ("GMP- 15:50- HND 17:50")
    const m2 = raw.match(/([A-Z]{3})\s*-?\s*([^A-Z]+)\s*([A-Z]{3})\s*([\s\S]*)/);
    if (m2) {
      result.from = m2[1];
      result.to = m2[3];
      rest = `${m2[2]} ${m2[4]}`;
    } else {
      const m3 = raw.match(/([A-Z]{3})([\s\S]*)/);
      if (!m3) return { ...result, timeOk: false };
      result.from = m3[1];
      result.to = '';
      rest = m3[2];
    }
  }

  rest = rest
    .replace(/^\s*\//, '')
    .replace(/[O]/g, '0')
    .replace(/[IL|]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8')
    .replace(/[.;]/g, ':')
    .replace(/[^0-9:\-]/g, '');

  const norm = (s) => {
    if (!s) return null;
    const [h, mi] = s.split(':');
    const hh = parseInt(h, 10);
    const mm = parseInt(mi, 10);
    if (hh > 23 || mm > 59) return 'BAD';
    return `${String(hh).padStart(2, '0')}:${mi}`;
  };

  const times = [...rest.matchAll(/\d{1,2}:\d{2}/g)];
  if (times.length >= 2) {
    result.dep = norm(times[0][0]);
    result.arr = norm(times[1][0]);
  } else if (times.length === 1) {
    const before = rest.slice(0, times[0].index);
    if (before.includes('-')) result.arr = norm(times[0][0]);
    else result.dep = norm(times[0][0]);
  } else if (rest.replace(/-/g, '')) {
    result.timeOk = false;
  }

  if (result.dep === 'BAD') { result.dep = null; result.timeOk = false; }
  if (result.arr === 'BAD') { result.arr = null; result.timeOk = false; }
  return result;
}

function kalIsoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function kalEditDistance1(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
  return diff === 1;
}

function kalAddDays(iso, days) {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.toISOString().slice(0, 10)}${iso.slice(10)}`;
}

/** Make sure arrival is after departure (UTC). Tries +1 day for overnight single-card flights. */
function kalFixArrivalOrder(f) {
  try {
    if (!f.departure || !f.arrival || !getAirport(f.from) || !getAirport(f.to)) return;
    const dep = parseFlightTime(f.departure, f.from, 'local');
    let arr = parseFlightTime(f.arrival, f.to, 'local');
    if (dep?.date && arr?.date && arr.date.getTime() <= dep.date.getTime()) {
      const plus1 = kalAddDays(f.arrival, 1);
      const arr2 = parseFlightTime(plus1, f.to, 'local');
      if (arr2?.date && arr2.date.getTime() > dep.date.getTime()) {
        f.arrival = plus1;
      } else {
        f.isUncertain.arrival = true;
      }
    }
  } catch (_) { /* leave as is */ }
}

/**
 * Recognizes the new Korean Air (HANWAY Crewnet) mobile schedule screenshot.
 * Long full-page captures are split automatically: top calendar header (year-month)
 * + one card per duty below.
 *
 * @param {File} file
 * @param {string} targetYearMonth fallback YYYY-MM
 * @param {Function} onProgress (ratio, text)
 * @returns {Promise<{ flights: Array, detectedYearMonth: string, diagnostics: Object }>}
 */
function kalUnfilterPngRows(raw, w, h, bpp) {
  const stride = w * bpp;
  const expected = (stride + 1) * h;
  if (raw.length === stride * h) {
    return raw;
  }
  if (raw.length < expected) return null;
  const out = new Uint8Array(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const rowIn = y * (stride + 1);
    const f = raw[rowIn];
    const srcOff = rowIn + 1;
    const dstOff = y * stride;
    const prevOff = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const byte = raw[srcOff + x];
      const a = x >= bpp ? out[dstOff + x - bpp] : 0;
      const b = y > 0 ? out[prevOff + x] : 0;
      const c = (y > 0 && x >= bpp) ? out[prevOff + x - bpp] : 0;
      let val = byte;
      if (f === 1) val = (byte + a) & 255;
      else if (f === 2) val = (byte + b) & 255;
      else if (f === 3) val = (byte + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        val = (byte + pr) & 255;
      }
      out[dstOff + x] = val;
    }
  }
  return out;
}

async function kalInflateZlib(compressedBytes) {
  for (const fmt of ['deflate', 'deflate-raw']) {
    try {
      const slice = fmt === 'deflate-raw' ? compressedBytes.subarray(2, compressedBytes.length - 4) : compressedBytes;
      const ds = new DecompressionStream(fmt);
      const writer = ds.writable.getWriter();
      writer.write(slice);
      writer.close();
      const ab = await new Response(ds.readable).arrayBuffer();
      return new Uint8Array(ab);
    } catch (_) {}
  }
  throw new Error('PDF 스트림 압축을 해제할 수 없습니다.');
}

async function extractKalPdfImage(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const latin1 = new TextDecoder('latin1').decode(buf);
  const parts = latin1.split('endobj');
  let rgbPixels = null, alphaPixels = null, width = 0, height = 0;

  let offset = 0;
  for (const part of parts) {
    const partLen = part.length;
    if (part.includes('/Subtype') && part.includes('/Image') && part.includes('stream')) {
      const sIdx = part.indexOf('stream');
      const hdr = part.slice(0, sIdx);
      const wMatch = hdr.match(/\/Width\s+(\d+)/);
      const hMatch = hdr.match(/\/Height\s+(\d+)/);
      const lMatch = hdr.match(/\/Length\s+(\d+)/);
      const csMatch = hdr.match(/\/ColorSpace\s*\/(\w+)/);
      if (wMatch && hMatch && lMatch && csMatch) {
        const w = parseInt(wMatch[1], 10);
        const h = parseInt(hMatch[1], 10);
        const len = parseInt(lMatch[1], 10);
        const cs = csMatch[1];
        let byteStart = offset + sIdx + 6;
        if (buf[byteStart] === 13 && buf[byteStart + 1] === 10) byteStart += 2;
        else if (buf[byteStart] === 10 || buf[byteStart] === 13) byteStart += 1;
        const compressed = buf.subarray(byteStart, byteStart + len);
        const raw = await kalInflateZlib(compressed);
        if (cs.includes('RGB')) {
          width = w;
          height = h;
          rgbPixels = kalUnfilterPngRows(raw, w, h, 3);
        } else if (cs.includes('Gray')) {
          alphaPixels = kalUnfilterPngRows(raw, w, h, 1);
        }
      }
    }
    offset += partLen + 6; // 'endobj'.length
  }

  if (!rgbPixels || !width || !height) {
    throw new Error('PDF 파일에서 스케줄 달력 이미지를 찾을 수 없습니다.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.createImageData(width, height);
  const dst = imageData.data;
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const s3 = i * 3;
    const d4 = i * 4;
    const a = alphaPixels ? alphaPixels[i] : 255;
    dst[d4]     = ((rgbPixels[s3]     * a + 255 * (255 - a)) / 255) | 0;
    dst[d4 + 1] = ((rgbPixels[s3 + 1] * a + 255 * (255 - a)) / 255) | 0;
    dst[d4 + 2] = ((rgbPixels[s3 + 2] * a + 255 * (255 - a)) / 255) | 0;
    dst[d4 + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return { canvas, ctx, imageData };
}

function loadKalImageFromFile(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
    return extractKalPdfImage(file);
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      if (!nw || !nh) {
        reject(new Error('이미지 크기를 확인할 수 없습니다.'));
        return;
      }
      // Preserve full resolution for calendar grid images (~1200x1400); cap only tall scroll captures
      let scale = 1;
      const isLongScroll = nh > nw * 2.5;
      if (isLongScroll && nw > 900) scale = Math.min(scale, 800 / nw);
      else if (!isLongScroll && nw > 1600) scale = Math.min(scale, 1400 / nw);
      if (nh * scale > 12000) scale = Math.min(scale, 12000 / nh);
      const cw = Math.max(1, Math.round(nw * scale));
      const ch = Math.max(1, Math.round(nh * scale));

      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, nw, nh, 0, 0, cw, ch);
      const imageData = ctx.getImageData(0, 0, cw, ch);
      resolve({ img, canvas, ctx, imageData });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지 파일을 읽을 수 없습니다.'));
    };
    img.src = url;
  });
}

function kalIsGridBorderPx(data, idx) {
  const r = data[idx], g = data[idx + 1], b = data[idx + 2];
  const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
  const avg = (r + g + b) / 3;
  return (maxC - minC <= 18) && avg >= 175 && avg <= 242;
}

/**
 * Detects the 7-column x 5/6-row monthly calendar grid in Korean Air PDF SKD (or screenshot).
 */
function detectKalPdfCalendarGrid(imageData) {
  const { data, width, height } = imageData;
  if (height > width * 2.4) return null; // Long vertical mobile scroll capture

  const ym1 = Math.round(height * 0.22);
  const ym2 = Math.round(height * 0.78);
  const spanY = Math.max(1, ym2 - ym1);
  const vClusters = [];
  for (let x = 0; x < width; x++) {
    let cnt = 0;
    for (let y = ym1; y < ym2; y++) {
      if (kalIsGridBorderPx(data, (y * width + x) * 4)) cnt++;
    }
    if (cnt / spanY > 0.48) {
      if (!vClusters.length || x - vClusters[vClusters.length - 1][vClusters[vClusters.length - 1].length - 1] > 12) {
        vClusters.push([x]);
      } else {
        vClusters[vClusters.length - 1].push(x);
      }
    }
  }
  const vCand = vClusters.map(g => Math.round(g.reduce((a, b) => a + b, 0) / g.length));
  let calV = null;
  for (let i = 0; i <= vCand.length - 8; i++) {
    const sub = vCand.slice(i, i + 8);
    const diffs = [];
    for (let k = 0; k < 7; k++) diffs.push(sub[k + 1] - sub[k]);
    const meanW = diffs.reduce((a, b) => a + b, 0) / 7;
    const maxDev = Math.max(...diffs.map(d => Math.abs(d - meanW)));
    if (meanW >= width * 0.09 && maxDev <= Math.max(8, meanW * 0.06)) {
      calV = sub;
      break;
    }
  }
  if (!calV) return null;
  const colW = (calV[7] - calV[0]) / 7;

  // Vertical activity of the 6 interior column lines calV[1..6]
  const vActive = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    let hits = 0;
    for (let c = 1; c <= 6; c++) {
      const vx = calV[c];
      for (let dx = -2; dx <= 2; dx++) {
        const xx = vx + dx;
        if (xx >= 0 && xx < width && kalIsGridBorderPx(data, (y * width + xx) * 4)) {
          hits++;
          break;
        }
      }
    }
    if (hits >= 4) vActive[y] = 1;
  }

  const nearXs = [];
  for (let c = 1; c <= 6; c++) {
    nearXs.push(calV[c] - 4, calV[c] - 3, calV[c] + 3, calV[c] + 4);
  }
  const hClusters = [];
  for (let y = 0; y < height; y++) {
    let nearHits = 0;
    for (const nx of nearXs) {
      if (nx >= 0 && nx < width && kalIsGridBorderPx(data, (y * width + nx) * 4)) nearHits++;
    }
    if (nearHits / nearXs.length < 0.55) continue;
    let fullHits = 0;
    const fullSpan = Math.max(1, calV[7] - calV[0]);
    for (let x = calV[0]; x < calV[7]; x += 2) {
      if (kalIsGridBorderPx(data, (y * width + x) * 4)) fullHits += 2;
    }
    if (fullHits / fullSpan < 0.65) continue;
    if (!hClusters.length || y - hClusters[hClusters.length - 1][hClusters[hClusters.length - 1].length - 1] > 15) {
      hClusters.push([y]);
    } else {
      hClusters[hClusters.length - 1].push(y);
    }
  }
  const rawH = hClusters.map(g => Math.round(g.reduce((a, b) => a + b, 0) / g.length));
  const filteredH = [];
  for (const y of rawH) {
    if (!filteredH.length || y - filteredH[filteredH.length - 1] >= colW * 0.60) {
      filteredH.push(y);
    }
  }
  const validIntervals = [];
  for (let r = 0; r < filteredH.length - 1; r++) {
    const y1 = filteredH[r] + 5;
    const y2 = filteredH[r + 1] - 5;
    let activeCnt = 0;
    for (let y = y1; y < y2; y++) if (vActive[y]) activeCnt++;
    if (y2 > y1 && activeCnt / (y2 - y1) > 0.70) validIntervals.push(r);
  }
  if (validIntervals.length < 4) return null;
  const calH = [filteredH[validIntervals[0]], ...validIntervals.map(r => filteredH[r + 1])];
  return { calV, calH, colW };
}

/**
 * Recognizes the 7-column Korean Air PDF SKD calendar grid format.
 */
async function recognizeKalPdfCalendarGrid(file, canvas, imageData, grid, targetYearMonth, notify, session, dict, diagnostics) {
  const { data, width, height } = imageData;
  const { calV, calH, colW } = grid;

  // 1. Detect Year-Month from filename or top-left header above calH[0] (excluding full-width horizontal lines)
  let yearNum = 0, monthNum = 0;
  let detectedYearMonth = targetYearMonth;
  const fnMatch = (file.name || '').match(/(20\d{2})[.\-_](\d{1,2})/);
  if (fnMatch) {
    const yv = parseInt(fnMatch[1], 10);
    const mv = parseInt(fnMatch[2], 10);
    if (mv >= 1 && mv <= 12) {
      yearNum = yv;
      monthNum = mv;
      detectedYearMonth = `${yv}-${String(mv).padStart(2, '0')}`;
    }
  }

  const ymY1 = Math.max(0, calH[0] - Math.round(colW * 0.62));
  const ymY2 = Math.max(0, calH[0] - Math.round(colW * 0.20));
  const ymX1 = calV[0];
  const ymX2 = calV[2];
  const ymW = Math.max(1, ymX2 - ymX1);
  let minY = Infinity, maxY = -1, minX = Infinity, maxX = -1;
  for (let y = ymY1; y < ymY2; y++) {
    let darkCnt = 0;
    for (let x = ymX1; x < ymX2; x++) {
      const i = (y * width + x) * 4;
      if (Math.min(data[i], data[i + 1], data[i + 2]) < 175) darkCnt++;
    }
    // Exclude full-width horizontal divider line (>50% of 2-column width)
    if (darkCnt > 2 && darkCnt < ymW * 0.45) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let x = ymX1; x < ymX2; x++) {
        const i = (y * width + x) * 4;
        if (Math.min(data[i], data[i + 1], data[i + 2]) < 175) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
  }
  if (maxY >= minY && maxX >= minX) {
    const t = kalBuildLineTensor(canvas, {
      x1: Math.max(0, minX - 3),
      y1: Math.max(0, minY - 3),
      x2: Math.min(width, maxX + 4),
      y2: Math.min(height, maxY + 4)
    });
    if (t) {
      const [ymTxt] = await kalRecognizeLines(session, dict, [t]);
      const m = (ymTxt || '').replace(/[Il|]/g, '1').replace(/[Oo]/g, '0').match(/(20\d{2})\s*[.\-\/]\s*(\d{1,2})/);
      if (m) {
        const yv = parseInt(m[1], 10);
        const mv = parseInt(m[2], 10);
        if (mv >= 1 && mv <= 12) {
          yearNum = yv;
          monthNum = mv;
          detectedYearMonth = `${yv}-${String(mv).padStart(2, '0')}`;
        }
      }
    }
  }
  if (!yearNum) {
    const [fy, fm] = (targetYearMonth || '').split('-').map(Number);
    yearNum = fy || new Date().getFullYear();
    monthNum = fm || (new Date().getMonth() + 1);
  }

  const firstDow = new Date(yearNum, monthNum - 1, 1).getDay(); // 0=SUN..6=SAT
  const daysInMonth = new Date(yearNum, monthNum, 0).getDate();

  // 2. Scan all in-month day cells for duty header bars and bottom info boxes
  const barCanvas = document.createElement('canvas');
  const barCtx = barCanvas.getContext('2d', { willReadFrequently: true });
  const duties = [];
  const stage1Items = [];

  const nRows = calH.length - 1;
  for (let r = 0; r < nRows; r++) {
    const ry1 = calH[r], ry2 = calH[r + 1];
    for (let c = 0; c < 7; c++) {
      const dayNum = r * 7 + c - firstDow + 1;
      if (dayNum < 1 || dayNum > daysInMonth) continue;

      const cx1 = calV[c], cx2 = calV[c + 1];
      const cw = cx2 - cx1;
      const sx1 = cx1 + Math.round(cw * 0.15);
      const sx2 = cx2 - Math.round(cw * 0.15);
      const sw = Math.max(1, sx2 - sx1);

      const bars = [];
      let st = -1;
      for (let y = ry1 + 4; y <= ry2 - 4; y++) {
        let barPx = 0;
        if (y < ry2 - 4) {
          for (let x = sx1; x < sx2; x++) {
            const i = (y * width + x) * 4;
            const pr = data[i], pg = data[i + 1], pb = data[i + 2];
            const chroma = Math.max(pr, pg, pb) - Math.min(pr, pg, pb);
            const mean = (pr + pg + pb) / 3;
            if (chroma > 30 || mean < 234) barPx++;
          }
        }
        const on = (y < ry2 - 4) && (barPx / sw > 0.75);
        if (on && st === -1) st = y;
        else if (!on && st !== -1) {
          if (y - st >= 12 && y - st <= 38) bars.push({ by1: st, by2: y });
          st = -1;
        }
      }

      for (let bi = 0; bi < bars.length; bi++) {
        const { by1, by2 } = bars[bi];
        const bx1 = cx1 + 6, bx2 = cx2 - 6;
        const bw = bx2 - bx1, bh = by2 - by1;
        if (bw <= 8 || bh <= 6) continue;

        // Sample bar background color near left edge of bar (before centered text)
        const sMidY = (by1 + by2) >> 1;
        let bgR = 0, bgG = 0, bgB = 0, bgCnt = 0;
        for (let sx = bx1 + 2; sx < Math.min(bx2, bx1 + 16); sx++) {
          const si = (sMidY * width + sx) * 4;
          bgR += data[si]; bgG += data[si + 1]; bgB += data[si + 2]; bgCnt++;
        }
        bgR = Math.round(bgR / Math.max(1, bgCnt));
        bgG = Math.round(bgG / Math.max(1, bgCnt));
        bgB = Math.round(bgB / Math.max(1, bgCnt));

        // Fast color skip: Olive-green (ADO/ATDO) has G - B > 60; Sky-blue (LO) has R > 65 and B - R > 45
        if (bgG - bgB > 60) continue;
        if (bgR > 65 && bgB - bgR > 45) continue;

        // Render bar as dark text on white background based on distance from (bgR, bgG, bgB)
        barCanvas.width = bw;
        barCanvas.height = bh;
        const barID = barCtx.createImageData(bw, bh);
        const bDst = barID.data;
        let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
        for (let yy = 0; yy < bh; yy++) {
          for (let xx = 0; xx < bw; xx++) {
            const si = ((by1 + yy) * width + (bx1 + xx)) * 4;
            const diff = Math.abs(data[si] - bgR) + Math.abs(data[si + 1] - bgG) + Math.abs(data[si + 2] - bgB);
            if (diff > 80) {
              if (xx < minX) minX = xx;
              if (xx > maxX) maxX = xx;
              if (yy < minY) minY = yy;
              if (yy > maxY) maxY = yy;
            }
            const v = Math.max(0, Math.min(255, Math.round(255 - diff * 1.2)));
            const di = (yy * bw + xx) * 4;
            bDst[di] = v; bDst[di + 1] = v; bDst[di + 2] = v; bDst[di + 3] = 255;
          }
        }
        if (maxX < minX) continue;
        barCtx.putImageData(barID, 0, 0);
        const t1 = kalBuildLineTensor(barCanvas, {
          x1: Math.max(0, minX - 3),
          y1: Math.max(0, minY - 2),
          x2: Math.min(bw, maxX + 4),
          y2: Math.min(bh, maxY + 3)
        });
        if (!t1) continue;

        const iy1 = by2 + 2;
        const iy2 = (bi + 1 < bars.length) ? (bars[bi + 1].by1 - 2) : (ry2 - 4);
        const dutyIdx = duties.length;
        duties.push({
          dayNum,
          codeText: '',
          infoBoxes: [],
          ix1: cx1 + 7,
          ix2: cx2 - 7,
          iy1,
          iy2
        });
        stage1Items.push({ ...t1, dutyIdx });
      }
    }
  }

  diagnostics.cardsDetected = duties.length;
  if (duties.length === 0) {
    await notify(1.0, '인식된 일정이 없습니다.');
    return { flights: [], detectedYearMonth, diagnostics };
  }

  // 3. Stage 1 OCR: Header bar codes (KE..., T_STBY, STBY, T_DO, T_NDUTY)
  await notify(0.25, `달력 일정 ${duties.length}개 편명 분석 중...`);
  stage1Items.sort((a, b) => a.w - b.w);
  const res1 = await kalRecognizeLines(session, dict, stage1Items);
  stage1Items.forEach((it, k) => {
    duties[it.dutyIdx].codeText = res1[k];
  });

  // 4. Stage 2 OCR: Info box lines ONLY for FLIGHT and STBY duties
  const stage2Items = [];
  duties.forEach((d, dutyIdx) => {
    const code = parseKalCode(d.codeText);
    d.parsedCode = code;
    if (code.kind !== 'FLIGHT' && code.kind !== 'STBY') return;

    const iw = Math.max(1, d.ix2 - d.ix1);
    const ibands = [];
    let ist = -1;
    for (let y = d.iy1; y <= d.iy2; y++) {
      let inkCnt = 0;
      if (y < d.iy2) {
        for (let x = d.ix1; x < d.ix2; x++) {
          const i = (y * width + x) * 4;
          if (Math.min(data[i], data[i + 1], data[i + 2]) < 195) inkCnt++;
        }
      }
      const frac = inkCnt / iw;
      const on = (y < d.iy2) && frac > 0.01 && frac < 0.70;
      if (on && ist === -1) ist = y;
      else if (!on && ist !== -1) {
        if (y - ist >= 5) ibands.push({ y1: ist, y2: y });
        ist = -1;
      }
    }

    ibands.forEach((b, lineOrder) => {
      let lMinX = Infinity, lMaxX = -1;
      for (let y = b.y1; y < b.y2; y++) {
        for (let x = d.ix1; x < d.ix2; x++) {
          const i = (y * width + x) * 4;
          if (Math.min(data[i], data[i + 1], data[i + 2]) < 195) {
            if (x < lMinX) lMinX = x;
            if (x > lMaxX) lMaxX = x;
          }
        }
      }
      if (lMaxX >= lMinX) {
        const t2 = kalBuildLineTensor(canvas, {
          x1: Math.max(0, lMinX - 3),
          y1: Math.max(0, b.y1 - 2),
          x2: Math.min(width, lMaxX + 4),
          y2: Math.min(height, b.y2 + 2)
        });
        if (t2) stage2Items.push({ ...t2, dutyIdx, lineOrder });
      }
    });
    d.infoLines = [];
  });

  await notify(0.55, `비행 구간·시간 ${stage2Items.length}건 분석 중...`);
  stage2Items.sort((a, b) => a.w - b.w);
  const STEP2 = 12;
  for (let s = 0; s < stage2Items.length; s += STEP2) {
    const part = stage2Items.slice(s, s + STEP2);
    const res2 = await kalRecognizeLines(session, dict, part);
    part.forEach((it, k) => {
      duties[it.dutyIdx].infoLines.push({ order: it.lineOrder, text: res2[k] });
    });
    const ratio = 0.55 + Math.min(1, (s + STEP2) / Math.max(1, stage2Items.length)) * 0.38;
    await notify(ratio, `비행 구간·시간 분석 중 (${Math.min(100, Math.round(((s + STEP2) / Math.max(1, stage2Items.length)) * 100))}%)...`);
  }

  // 5. Build and merge flights chronologically
  const flights = [];
  let open = null;
  const pushOpen = () => {
    if (open) {
      open.isUncertain.arrival = true;
      flights.push(open);
      open = null;
    }
  };

  for (const d of duties) {
    if (d.parsedCode.kind !== 'FLIGHT' && d.parsedCode.kind !== 'STBY') continue;
    const line2Text = (d.infoLines || []).sort((a, b) => a.order - b.order).map(x => x.text).join(' ');
    const sector = parseKalSector(line2Text);
    const iso = kalIsoDate(yearNum, monthNum, d.dayNum);

    if (d.parsedCode.kind === 'STBY') {
      flights.push({
        number: 'STBY',
        from: (sector.from && getAirport(sector.from)) ? sector.from : 'ICN',
        to: (sector.from && getAirport(sector.from)) ? sector.from : 'ICN',
        departure: `${iso}T${sector.dep || '00:00'}`,
        arrival: `${iso}T${sector.arr || '23:59'}`,
        isUncertain: { number: false, from: false, to: false, departure: !sector.dep, arrival: !sector.arr }
      });
      continue;
    }

    const fromValid = Boolean(sector.from && getAirport(sector.from));
    const toValid = Boolean(sector.to && getAirport(sector.to));
    const f = {
      number: d.parsedCode.number,
      from: sector.from,
      to: sector.to,
      departure: '',
      arrival: '',
      isUncertain: {
        number: false,
        from: !fromValid,
        to: !toValid,
        departure: false,
        arrival: false
      }
    };
    const sameLeg = (o) => o && o.number === f.number && (o.from === f.from || o.to === f.to);

    if (sector.dep && sector.arr) {
      pushOpen();
      f.departure = `${iso}T${sector.dep}`;
      f.arrival = `${iso}T${sector.arr}`;
      kalFixArrivalOrder(f);
      flights.push(f);
    } else if (sector.dep) {
      pushOpen();
      f.departure = `${iso}T${sector.dep}`;
      f.isUncertain.arrival = true;
      open = f;
    } else if (sector.arr) {
      if (sameLeg(open)) {
        open.arrival = `${iso}T${sector.arr}`;
        open.isUncertain.arrival = false;
        kalFixArrivalOrder(open);
        flights.push(open);
        open = null;
      } else {
        pushOpen();
        f.arrival = `${iso}T${sector.arr}`;
        f.isUncertain.departure = true;
        flights.push(f);
      }
    } else if (!sameLeg(open)) {
      pushOpen();
      f.isUncertain.departure = true;
      f.isUncertain.arrival = true;
      open = f;
    }
  }
  pushOpen();

  diagnostics.extractedFlights = flights;
  await notify(1.0, `PDF SKD 인식 완료 (${flights.length}편 추출)`);
  return { flights, detectedYearMonth, diagnostics };
}

export async function recognizeKoreanAirNewPhoto(file, targetYearMonth, onProgress) {
  if (!file) throw new Error('파일이 선택되지 않았습니다.');

  const diagnostics = { imageWidth: 0, imageHeight: 0, cardsDetected: 0, cards: [], extractedFlights: [] };
  const notify = async (ratio, text) => {
    if (onProgress) { try { onProgress(ratio, text); } catch (_) {} }
    await new Promise(r => setTimeout(r, 0));
  };

  await notify(0.06, 'PDF / 스케줄 이미지 읽는 중...');
  const { canvas, imageData } = await loadKalImageFromFile(file);
  const { width, height } = imageData;
  diagnostics.imageWidth = width;
  diagnostics.imageHeight = height;

  await notify(0.10, 'PDF SKD 인식 모델 준비 중...');
  const { session, dict } = await loadOCR();

  await notify(0.14, '스케줄 달력 영역 검출 중...');
  const pdfGrid = detectKalPdfCalendarGrid(imageData);
  if (pdfGrid) {
    return await recognizeKalPdfCalendarGrid(file, canvas, imageData, pdfGrid, targetYearMonth, notify, session, dict, diagnostics);
  }

  const cards = detectKalCards(imageData);
  diagnostics.cardsDetected = cards.length;
  if (cards.length === 0) {
    await notify(1.0, '인식된 대한항공 일정 카드가 없습니다.');
    return { flights: [], detectedYearMonth: targetYearMonth, diagnostics };
  }

  const minBandH = Math.max(4, Math.round(width * 0.0077));
  const pad = Math.max(2, Math.round(width * 0.005));
  const white = [255, 255, 255];

  // ── (a) Year / month header: look above the first card (left column "2026.12", date box "2026-12-01")
  const headerLimit = cards[0].y1;
  const headerItems = [];
  for (const [hx1, hx2] of [[0.07, 0.26], [0.40, 0.70]]) {
    const x1 = Math.round(width * hx1);
    const x2 = Math.round(width * hx2);
    const bands = kalFindBands(imageData, x1, Math.round(headerLimit * 0.20), x2, Math.round(headerLimit * 0.60), white, 150, minBandH);
    for (const b of bands) {
      if (b.h < 14 || b.h > 50) continue;
      const box = kalTightBox(imageData, x1, b.y1 - 1, x2, b.y2 + 1, white, 150, pad);
      if (!box) continue;
      const aspect = (box.x2 - box.x1) / Math.max(1, box.y2 - box.y1);
      if (aspect < 2.2 || aspect > 8.5) continue;
      const t = kalBuildLineTensor(canvas, box);
      if (t) headerItems.push(t);
    }
  }
  let yearNum;
  let monthNum;
  let detectedYearMonth = targetYearMonth;
  if (headerItems.length > 0) {
    await notify(0.16, '상단 연월 확인 중...');
    const hTexts = await kalRecognizeLines(session, dict, headerItems.slice(0, 8));
    for (const txt of hTexts) {
      const m = (txt || '').match(/(20\d{2})\s*[.\-\/]\s*(\d{1,2})/);
      if (m) {
        const yv = parseInt(m[1], 10);
        const mv = parseInt(m[2], 10);
        if (mv >= 1 && mv <= 12) {
          yearNum = yv;
          monthNum = mv;
          detectedYearMonth = `${yv}-${String(mv).padStart(2, '0')}`;
          break;
        }
      }
    }
  }
  if (!yearNum) {
    const [fy, fm] = (targetYearMonth || '').split('-').map(Number);
    yearNum = fy || new Date().getFullYear();
    monthNum = fm || (new Date().getMonth() + 1);
  }

  // ── (b) Per card: day label (only on the first card of a day), line 1, line 2
  const tx1 = Math.round(width * 0.297);
  const tx2 = Math.round(width * 0.78);
  const dx1 = Math.round(width * 0.07);
  const dx2 = Math.round(width * 0.25);
  const rowMeta = cards.map(() => ({ hasDayLabel: false, day: '', line1: '', line2: '', line2Box: null }));
  const stage1Items = [];

  cards.forEach((c, i) => {
    // day label
    const dBands = kalFindBands(imageData, dx1, c.y1 - Math.round(width * 0.013), dx2, c.y2, white, 120, minBandH);
    if (dBands.length > 0) {
      const big = dBands.reduce((a, b) => (b.h > a.h ? b : a));
      if (big.h >= Math.round(width * 0.024)) {
        const box = kalTightBox(imageData, dx1, big.y1 - 1, dx2, big.y2 + 1, white, 120, pad);
        const t = box && kalBuildLineTensor(canvas, box);
        if (t) {
          rowMeta[i].hasDayLabel = true;
          stage1Items.push({ ...t, cardIdx: i, kind: 'day' });
        }
      }
    }
    // text lines: 1-line cards (ADO / ATDO) have no sector/time line and can be skipped immediately
    const lines = kalFindBands(imageData, tx1, c.y1 + 4, tx2, c.y2 - 4, c.bg, 90, minBandH);
    if (lines.length < 2) return;

    const box1 = kalTightBox(imageData, tx1, lines[0].y1 - 2, tx2, lines[0].y2 + 2, c.bg, 90, pad);
    const t1 = box1 && kalBuildLineTensor(canvas, box1);
    if (t1) stage1Items.push({ ...t1, cardIdx: i, kind: 'line1' });

    const box2 = kalTightBox(imageData, tx1, lines[1].y1 - 2, tx2, lines[1].y2 + 2, c.bg, 90, pad);
    if (box2) rowMeta[i].line2Box = box2;
  });

  // ── (c) Stage 1 Recognition: narrow items (day numbers & flight/duty codes) sorted by width
  await notify(0.22, `일정 카드 ${cards.length}개 날짜·편명 분석 중...`);
  stage1Items.sort((a, b) => a.w - b.w);
  const STEP1 = 24;
  for (let s = 0; s < stage1Items.length; s += STEP1) {
    const part = stage1Items.slice(s, s + STEP1);
    const res = await kalRecognizeLines(session, dict, part);
    part.forEach((it, k) => {
      if (it.kind === 'day') rowMeta[it.cardIdx].day = res[k];
      else rowMeta[it.cardIdx].line1 = res[k];
    });
    const ratio = 0.22 + Math.min(1, (s + STEP1) / Math.max(1, stage1Items.length)) * 0.30;
    await notify(ratio, `날짜·편명 분석 중 (${Math.min(100, Math.round(((s + STEP1) / Math.max(1, stage1Items.length)) * 100))}%)...`);
  }

  // Stage 2 Recognition: sector & time line ONLY for actual FLIGHT or STBY cards (skips LO / T_DO)
  const stage2Items = [];
  rowMeta.forEach((m, i) => {
    const code = parseKalCode(m.line1);
    if ((code.kind === 'FLIGHT' || code.kind === 'STBY') && m.line2Box) {
      const t2 = kalBuildLineTensor(canvas, m.line2Box);
      if (t2) stage2Items.push({ ...t2, cardIdx: i });
    }
  });

  stage2Items.sort((a, b) => a.w - b.w);
  const STEP2 = 12;
  for (let s = 0; s < stage2Items.length; s += STEP2) {
    const part = stage2Items.slice(s, s + STEP2);
    const res = await kalRecognizeLines(session, dict, part);
    part.forEach((it, k) => {
      rowMeta[it.cardIdx].line2 = res[k];
    });
    const ratio = 0.52 + Math.min(1, (s + STEP2) / Math.max(1, stage2Items.length)) * 0.40;
    await notify(ratio, `비행 구간·시간 분석 중 (${Math.min(100, Math.round(((s + STEP2) / Math.max(1, stage2Items.length)) * 100))}%)...`);
  }

  await notify(0.93, '일정 병합 및 검증 중...');

  // ── (d) Interpret cards chronologically
  const parsedCards = rowMeta.map(m => ({
    ...m,
    code: parseKalCode(m.line1),
    sector: parseKalSector(m.line2)
  }));

  // Known-good airport codes seen in this screenshot → used to repair single-letter OCR slips.
  const knownCodes = new Set();
  parsedCards.forEach(p => {
    [p.sector.from, p.sector.to].forEach(c => { if (c && getAirport(c)) knownCodes.add(c); });
  });
  const repairCode = (code) => {
    if (!code) return { code, repaired: false, valid: false };
    if (getAirport(code)) return { code, repaired: false, valid: true };
    for (const k of knownCodes) {
      if (kalEditDistance1(code, k)) return { code: k, repaired: true, valid: true };
    }
    return { code, repaired: false, valid: false };
  };

  const flights = [];
  let lastDay = 0;
  let open = null;
  const pushOpen = () => {
    if (open) {
      open.isUncertain.arrival = true;
      flights.push(open);
      open = null;
    }
  };

  parsedCards.forEach((p, idx) => {
    // day number
    let dayUncertain = false;
    if (p.hasDayLabel) {
      const dm = (p.day || '').replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').match(/\d{1,2}/);
      const parsedDay = dm ? parseInt(dm[0], 10) : NaN;
      if (parsedDay >= 1 && parsedDay <= 31 && (lastDay === 0 || (parsedDay > lastDay && parsedDay <= lastDay + 3))) {
        lastDay = parsedDay;
      } else if (lastDay === 0 && !(parsedDay >= 1 && parsedDay <= 31)) {
        lastDay = 1;
        dayUncertain = true;
      } else {
        lastDay = Math.min(31, lastDay + 1); // every day appears in the list → expect consecutive days
        dayUncertain = true;
      }
    } else if (lastDay === 0) {
      lastDay = 1;
      dayUncertain = true;
    }
    const iso = kalIsoDate(yearNum, monthNum, lastDay);

    diagnostics.cards.push({
      i: idx + 1, day: lastDay, line1: p.line1, line2: p.line2, kind: p.code.kind
    });

    if (p.code.kind === 'EMPTY' || p.code.kind === 'OTHER') {
      return; // ADO / ATDO / T_DO / LO ... => no schedule
    }

    const from = repairCode(p.sector.from);
    const to = repairCode(p.sector.to || p.sector.from);

    if (p.code.kind === 'STBY') {
      const dep = p.sector.dep || '00:00';
      const arr = p.sector.arr || '23:59';
      flights.push({
        number: 'STBY',
        from: from.code || 'ICN',
        to: from.code || 'ICN',
        departure: `${iso}T${dep}`,
        arrival: `${iso}T${arr}`,
        isUncertain: { number: false, from: !from.valid || from.repaired, to: false, departure: !p.sector.dep, arrival: !p.sector.arr }
      });
      return;
    }

    // FLIGHT
    const f = {
      number: p.code.number,
      from: from.code,
      to: to.code,
      departure: '',
      arrival: '',
      isUncertain: {
        number: false,
        from: !from.valid || from.repaired,
        to: !to.valid || to.repaired,
        departure: false,
        arrival: false
      }
    };
    const sameLeg = (o) => o && o.number === f.number && (o.from === f.from || o.to === f.to);
    const flightsBefore = flights.length;

    if (p.sector.dep && p.sector.arr) {
      pushOpen();
      f.departure = `${iso}T${p.sector.dep}`;
      f.arrival = `${iso}T${p.sector.arr}`;
      kalFixArrivalOrder(f);
      flights.push(f);
    } else if (p.sector.dep) {
      // departs today, lands another day ("20:00 -")
      pushOpen();
      f.departure = `${iso}T${p.sector.dep}`;
      f.isUncertain.arrival = true;
      open = f;
    } else if (p.sector.arr) {
      // lands today ("- 08:20")
      if (sameLeg(open)) {
        open.arrival = `${iso}T${p.sector.arr}`;
        open.isUncertain.arrival = false;
        if (!open.isUncertain.from && !from.valid) open.isUncertain.from = true;
        kalFixArrivalOrder(open);
        flights.push(open);
        open = null;
      } else {
        pushOpen();
        f.arrival = `${iso}T${p.sector.arr}`;
        f.isUncertain.departure = true;
        flights.push(f);
      }
    } else {
      // in the air all day ("-")
      if (!sameLeg(open)) {
        pushOpen();
        f.isUncertain.departure = true;
        f.isUncertain.arrival = true;
        open = f;
      }
    }
    const touched = open === f ? f : (flights.length > flightsBefore ? flights[flights.length - 1] : open);
    if (touched && (dayUncertain || !p.sector.timeOk)) {
      touched.isUncertain.departure = true;
      touched.isUncertain.arrival = true;
    }
  });
  pushOpen();

  diagnostics.extractedFlights = flights;
  if (typeof window !== 'undefined' && window.__KAL_DEBUG) {
    console.table(diagnostics.cards);
    console.table(flights);
  }
  await notify(1.0, `대한항공 인식 완료 (${flights.length}편 추출)`);

  return { flights, detectedYearMonth, diagnostics };
}
