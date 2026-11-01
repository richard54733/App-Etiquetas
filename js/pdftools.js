/*
 * pdftools.js — junção de PDFs (pdf-lib), miniaturas e rasterização (pdf.js).
 */
import * as pdfjs from '../vendor/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const PDFLib = () => window.PDFLib;

/** Carrega um documento pdf.js a partir de bytes */
export async function openPdf(bytes) {
  return pdfjs.getDocument({ data: bytes.slice ? bytes.slice(0) : bytes, isEvalSupported: false }).promise;
}

/**
 * Junta os itens: [{ bytes, qty, name }] → Uint8Array de um PDF único.
 * Cada PDF de origem é lido uma vez; as páginas são copiadas `qty` vezes.
 */
export async function mergePdfs(entries, title = 'Etiquetas') {
  const { PDFDocument } = PDFLib();
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setCreator('Etiquetas — app');
  for (const e of entries) {
    if (!e.qty) continue;
    const src = await PDFDocument.load(e.bytes, { ignoreEncryption: true });
    const idx = src.getPageIndices();
    for (let c = 0; c < e.qty; c++) {
      const pages = await out.copyPages(src, idx);
      pages.forEach((p) => out.addPage(p));
    }
  }
  return out.save();
}

/** Página de teste de alinhamento (A4) com régua em mm e quadrados de cor */
export async function testPagePdf(paper = 'A4') {
  const { PDFDocument, rgb, StandardFonts } = PDFLib();
  const doc = await PDFDocument.create();
  const [W, H] = paper === 'LETTER' ? [612, 792] : [595.28, 841.89];
  const page = doc.addPage([W, H]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const mm = 72 / 25.4;
  const ink = rgb(0, 0, 0);
  // moldura a 10 mm da borda
  page.drawRectangle({ x: 10 * mm, y: 10 * mm, width: W - 20 * mm, height: H - 20 * mm, borderColor: ink, borderWidth: 0.8 });
  // réguas em mm no topo e à esquerda (a partir da borda do papel)
  for (let i = 0; i * mm < W; i++) {
    const len = i % 10 === 0 ? 7 : i % 5 === 0 ? 4.5 : 2.5;
    page.drawLine({ start: { x: i * mm, y: H - 30 * mm }, end: { x: i * mm, y: H - (30 + len) * mm }, thickness: 0.4, color: ink });
    if (i % 10 === 0 && i) page.drawText(String(i), { x: i * mm - 4, y: H - 41 * mm, size: 7, font });
  }
  for (let i = 0; i * mm < H; i++) {
    const len = i % 10 === 0 ? 7 : i % 5 === 0 ? 4.5 : 2.5;
    page.drawLine({ start: { x: 30 * mm, y: H - i * mm }, end: { x: (30 + len) * mm, y: H - i * mm }, thickness: 0.4, color: ink });
    if (i % 10 === 0 && i) page.drawText(String(i), { x: 39 * mm, y: H - i * mm - 2.5, size: 7, font });
  }
  page.drawText('Teste de impressão', { x: 60 * mm, y: H - 70 * mm, size: 28, font, color: ink });
  page.drawText('A moldura deve ficar a 10 mm de cada borda do papel.', { x: 60 * mm, y: H - 80 * mm, size: 11, font });
  page.drawText('Meça com uma régua e ajuste em Impressora > Ajuste de posição.', { x: 60 * mm, y: H - 87 * mm, size: 11, font });
  const sw = [[0, 0, 0], [0, 0.6, 0.9], [0.9, 0.1, 0.5], [1, 0.85, 0], [0.9, 0.1, 0.1], [0, 0.6, 0.3]];
  sw.forEach((c, i) => page.drawRectangle({ x: (60 + i * 22) * mm, y: H - 120 * mm, width: 18 * mm, height: 18 * mm, color: rgb(...c) }));
  // código de barras de teste (traços finos)
  for (let i = 0; i < 60; i++) {
    const w = (i * 7) % 3 + 1;
    page.drawRectangle({ x: 60 * mm + i * 3.2, y: H - 150 * mm, width: w * 0.5, height: 20 * mm, color: ink });
  }
  return doc.save();
}

/** Miniatura (dataURL webp) do topo-esquerdo da 1ª página, como no catálogo */
export async function makeThumb(bytes) {
  const doc = await openPdf(bytes);
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1.6 });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  // recorta o conteúdo do canto superior esquerdo (primeira etiqueta)
  const rw = Math.floor(c.width / 3), rh = Math.floor(c.height / 5);
  const d = ctx.getImageData(0, 0, rw, rh).data;
  let x0 = rw, y0 = rh, x1 = 0, y1 = 0;
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = (y * rw + x) * 4;
    if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  }
  let sx = 0, sy = 0, sw = c.width, sh = c.height;
  if (x1 > x0 && y1 > y0) { const p = 10; sx = Math.max(0, x0 - p); sy = Math.max(0, y0 - p); sw = Math.min(rw, x1 + p) - sx; sh = Math.min(rh, y1 + p) - sy; }
  const t = document.createElement('canvas');
  const k = Math.min(1, 480 / sw);
  t.width = Math.round(sw * k); t.height = Math.round(sh * k);
  t.getContext('2d').drawImage(c, sx, sy, sw, sh, 0, 0, t.width, t.height);
  const pages = doc.numPages;
  doc.destroy();
  return { thumb: t.toDataURL('image/webp', 0.88), pages };
}

/**
 * Rasteriza uma página a `dpi`, em faixas, entregando linhas RGB.
 * offX/offY: deslocamento (em pixels) entre o papel e a origem da impressora.
 * onRow(y, rgbRow) é chamado para cada linha y = 0..height-1.
 */
export async function rasterizePage(doc, pageNum, { dpi = 360, width, height, offX = 0, offY = 0, onRow, onProgress, gray = false }) {
  const page = await doc.getPage(pageNum);
  const scale = dpi / 72;
  const vp = page.getViewport({ scale });
  const BAND = 512;
  const c = document.createElement('canvas');
  c.width = width; c.height = BAND;
  const ctx = c.getContext('2d', { willReadFrequently: true, alpha: false });
  const row = new Uint8Array(width * 3);
  const pageH = Math.ceil(vp.height);
  for (let y0 = 0; y0 < height; y0 += BAND) {
    const h = Math.min(BAND, height - y0);
    // a faixa toda fora do papel não precisa ser desenhada
    if (y0 + offY >= pageH) { row.fill(255); for (let y = 0; y < h; y++) onRow(y0 + y, row); continue; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, BAND);
    await page.render({
      canvasContext: ctx, viewport: vp,
      transform: [1, 0, 0, 1, -offX, -(y0 + offY)],
      background: 'rgb(255,255,255)',
      intent: 'print',
    }).promise;
    const img = ctx.getImageData(0, 0, width, h).data;
    for (let y = 0; y < h; y++) {
      const base = y * width * 4;
      for (let x = 0, o = 0, i = base; x < width; x++, i += 4) {
        if (gray) { const v = (img[i] * 77 + img[i + 1] * 151 + img[i + 2] * 28) >> 8; row[o++] = v; row[o++] = v; row[o++] = v; }
        else { row[o++] = img[i]; row[o++] = img[i + 1]; row[o++] = img[i + 2]; }
      }
      onRow(y0 + y, row);
    }
    onProgress?.(Math.min(1, (y0 + h) / height));
    await new Promise((r) => setTimeout(r, 0));
  }
  page.cleanup();
}
