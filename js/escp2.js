/*
 * escp2.js — Gerador ESC/P2 (raster) para impressoras Epson mais antigas que
 * NÃO entendem ESC/P-R, como a Epson L210 / L110 / L300 / L355 (família 2012).
 *
 * Os comandos e parâmetros foram levantados do projeto aberto Gutenprint
 * (modelo "escp2-l210", id 80, GPL-2.0+) e conferidos renderizando a saída
 * com a ferramenta "unprint" do próprio Gutenprint.
 *
 * Modo usado: 360×360 dpi, gotas variáveis (2 bits por ponto),
 * cabeça preta de 180 bicos / cabeça colorida de 60 bicos, espaçados 1/180".
 * Como os bicos estão a 1/180", cada faixa é impressa em 2 passadas
 * (linhas pares e depois ímpares, avançando 1/360").
 */

export const L210_PAPERS = {
  // w = largura (1/360"), len = comprimento de página enviado (ESC ( C),
  // bottom = margem inferior (ESC ( c), dataW = pixels por linha (área útil)
  A4:     { name: 'A4',    w: 2975, len: 4330, bottom: 4170, dataW: 2888, left: 45 },
  LETTER: { name: 'Carta', w: 3060, len: 4080, bottom: 3920, dataW: 2976, left: 45 },
};

const enc = (s) => Array.from(s, (c) => c.charCodeAt(0));
const le16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
const le32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
const paren = (c, args) => [0x1B, 0x28, c.charCodeAt(0), ...le16(args.length), ...args];

/** Compressão TIFF PackBits (usada por ESC i com compressão = 1). */
export function packBits(src, out, o) {
  const n = src.length;
  let i = 0;
  while (i < n) {
    // procura repetição
    let run = 1;
    while (i + run < n && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 2) {
      out[o++] = (257 - run) & 0xFF;
      out[o++] = src[i];
      i += run;
      continue;
    }
    // literal até achar repetição de 2+
    let start = i, lit = 0;
    while (i < n && lit < 128) {
      if (i + 1 < n && src[i] === src[i + 1]) break;
      i++; lit++;
    }
    out[o++] = lit - 1;
    for (let k = 0; k < lit; k++) out[o++] = src[start + k];
  }
  return o;
}

// Matriz de Bayer 8×8 para meio-tom (pontilhado ordenado)
const BAYER = (() => {
  const m = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
  return Uint8Array.from(m, (v) => Math.round((v + 0.5) * 4));
})();

/** Converte 0..255 de "quantidade de tinta" em gota 0..3 (nenhuma, pequena, média, grande) */
function dot(v, x, y) {
  if (v <= 0) return 0;
  if (v >= 250) return 3;
  const t = BAYER[((y & 7) << 3) | (x & 7)]; // 2..254
  // 3 níveis de gota: divide a faixa em 3 degraus com pontilhado
  const s = v * 3;               // 0..765
  const level = Math.floor(s / 256);
  const frac = s - level * 256;
  return Math.min(3, level + (frac > t ? 1 : 0));
}

/** Deixa bordas de texto e código de barras nítidas: tons perto do branco/preto viram branco/preto puro */
function crisp(k) {
  if (k <= 60) return 0;
  if (k >= 190) return 255;
  return Math.round((k - 60) * 255 / 130);
}

/**
 * Trabalho ESC/P2 para L210. A página é entregue linha a linha (RGB, 360 dpi,
 * largura = dataW), e os dados são agrupados em faixas para as passadas.
 */
export class Escp2Job {
  constructor(sink, o = {}) {
    this.sink = sink;
    this.paper = L210_PAPERS[o.paper || 'A4'] || L210_PAPERS.A4;
    this.color = !!o.color;
    // unidirecional: a cabeça só imprime indo para um lado. Na L210 o modo de ida-e-volta
    // desalinha as passadas e deixa barras de código de barras serrilhadas/dobradas.
    this.bidir = o.bidirectional ?? false;
    this.nozzles = this.color ? 60 : 180;      // bicos por cor
    this.band = this.nozzles * 2;              // linhas cobertas por 2 passadas
    this.channels = this.color ? [0, 2, 1, 4] : [0]; // K, C, M, Y (códigos ESC/P2)
    // deslocamento físico de cada grupo de bicos, em linhas de 1/360" (Gutenprint: inks/c82.xml)
    this.offsets = this.color ? [0, 0, 120, 240] : [0];
    this.bytesPerRow = Math.ceil(this.paper.dataW * 2 / 8);
    this.blank = new Uint8Array(this.bytesPerRow);
    this.buf = []; this.pending = 0;
  }

  get width() { return this.paper.dataW; }
  get height() { return this.paper.bottom; }

  push(b) {
    const u = b instanceof Uint8Array ? b : Uint8Array.from(b);
    this.buf.push(u); this.pending += u.length;
    if (this.pending >= 64 * 1024) this.flush();
  }
  flush() {
    if (!this.pending) return;
    const out = new Uint8Array(this.pending); let o = 0;
    for (const b of this.buf) { out.set(b, o); o += b.length; }
    this.buf = []; this.pending = 0; this.sink(out);
  }

  startJob() {
    const p = this.paper;
    this.push([
      0x00, 0x00, 0x00, 0x1B, 0x01, ...enc('@EJL 1284.4\n@EJL     \n'),
      0x1B, 0x40, 0x1B, 0x40,
      0x1B, 0x28, 0x52, 0x08, 0x00, 0x00, ...enc('REMOTE1'),
      ...enc('PM'), 0x02, 0x00, 0x00, 0x00,
      ...enc('SN'), 0x03, 0x00, 0x00, 0x00, 0x01,
      0x1B, 0x00, 0x00, 0x00,
    ]);
    this.pageSetup = [
      ...paren('G', [0x01]),
      ...paren('U', [0x08, 0x08, 0x08, 0x40, 0x0b]),
      ...paren('K', [0x00, this.color ? 0x02 : 0x01]),
      ...paren('i', [0x00]),
      0x1B, 0x55, this.bidir ? 0 : 1,
      ...paren('e', [0x00, 0x10]),
      ...paren('D', [0x40, 0x38, 0x50, 0x28]),
      ...paren('C', le32(p.len)),
      ...paren('c', [...le32(this.color ? -240 : 0), ...le32(p.bottom)]),
      ...paren('S', [...le32(p.w), ...le32(p.len)]),
    ];
    // o Gutenprint envia a configuração uma vez, logo após o modo remoto
    this.push(this.pageSetup);
  }

  startPage() {
    // a página inteira fica em memória (2 bits/ponto): no modo cor cada tinta sai
    // de um grupo de bicos diferente, então uma passada mistura linhas de alturas diferentes
    this.planes = this.channels.map(() => new Uint8Array(this.height * this.bytesPerRow));
    this.rowInk = this.channels.map(() => new Uint8Array(this.height));
    this.head = 0; // mesmos avanços do Gutenprint (no modo cor ele declara topo -240 no ESC ( c)
    this.comp = new Uint8Array(this.nozzles * (this.bytesPerRow + Math.ceil(this.bytesPerRow / 128) + 4));
  }

  /** Recebe a linha y (0 = topo da área útil) em RGB. */
  line(y, rgb) {
    if (y < 0 || y >= this.height) return;
    const W = Math.min(this.paper.dataW, rgb.length / 3);
    const off = y * this.bytesPerRow;
    for (let x = 0; x < W; x++) {
      const R = rgb[x * 3], G = rgb[x * 3 + 1], B = rgb[x * 3 + 2];
      if (R === 255 && G === 255 && B === 255) continue;
      const sh = 6 - ((x & 3) << 1), bi = off + (x >> 2);
      if (!this.color) {
        const k = crisp(255 - ((R * 77 + G * 151 + B * 28) >> 8));
        const d = dot(k, x, y);
        if (d) { this.planes[0][bi] |= d << sh; this.rowInk[0][y] = 1; }
      } else {
        let c = 255 - R, m = 255 - G, yy = 255 - B;
        // preto só onde a cor é neutra (cinza/preto); cores vivas ficam só com C, M e Y
        const mn = Math.min(c, m, yy), mx = Math.max(c, m, yy);
        const neutral = 1 - (mx - mn) / 255;
        const k = crisp(Math.round(mn * neutral * neutral));
        c -= k; m -= k; yy -= k;
        const vals = [k, c, m, yy];
        for (let ch = 0; ch < 4; ch++) {
          const d = dot(vals[ch], x + ch * 3, y + ch * 5);
          if (d) { this.planes[ch][bi] |= d << sh; this.rowInk[ch][y] = 1; }
        }
      }
    }
  }

  moveTo(row) {
    const dy = row - this.head;
    if (dy > 0) this.push(paren('v', le32(dy)));
    this.head = row;
  }

  /**
   * Uma passada com a cabeça na linha P. O bico n de cada tinta cai na linha lógica P + 2n;
   * para a tinta com deslocamento h isso é a linha da imagem P + 2n − h, porque na L210 os bicos
   * magenta e amarelo ficam 120 e 240 linhas acima dos bicos preto/ciano (headOffset do Gutenprint).
   * Cada linha lógica só é impressa pela passada "dona" dela (owner), então nada sai duplicado.
   */
  emitPass(k, P, owner) {
    const sends = [];
    for (let ch = 0; ch < this.channels.length; ch++) {
      const h = this.offsets[ch];
      const plane = this.planes[ch], ink = this.rowInk[ch];
      const rowOf = (n) => { const L = P + 2 * n; const r = L - h; return owner[L] === k && r >= 0 && r < this.height ? r : -1; };
      let has = false;
      for (let n = 0; n < this.nozzles; n++) { const r = rowOf(n); if (r >= 0 && ink[r]) { has = true; break; } }
      if (!has) continue;
      let o = 0;
      for (let n = 0; n < this.nozzles; n++) {
        const r = rowOf(n);
        const src = r >= 0 ? plane.subarray(r * this.bytesPerRow, (r + 1) * this.bytesPerRow) : this.blank;
        o = packBits(src, this.comp, o);
      }
      sends.push([this.channels[ch], this.comp.slice(0, o)]);
    }
    if (!sends.length) return;
    this.moveTo(P);
    for (const [code, data] of sends) {
      this.push([0x1B, 0x69, code, 0x01, 0x02, ...le16(this.bytesPerRow), ...le16(this.nozzles)]);
      this.push(data);
      this.push([0x0D]);
    }
  }

  /**
   * Entrelaçamento igual ao do Gutenprint: passadas em 0, 1 e depois avançando (bicos − 1) linhas
   * (59 em cor, 179 em preto). Passadas seguidas alternam linhas pares e ímpares, deslocadas meia
   * faixa, então as emendas entre faixas não caem todas na mesma linha. Isso tira as listras
   * claras que apareciam atravessando as barras do código de barras.
   */
  endPage() {
    const maxOff = Math.max(...this.offsets);
    const lastL = this.height + maxOff;
    const adv = this.nozzles - 1;
    const passes = [0, 1];
    while (passes[passes.length - 1] <= lastL) passes.push(passes[passes.length - 1] + adv);
    const owner = new Int32Array(lastL + 2 * this.nozzles + 2).fill(-1);
    passes.forEach((P, k) => { for (let n = 0; n < this.nozzles; n++) { const L = P + 2 * n; if (L < owner.length && owner[L] < 0) owner[L] = k; } });
    passes.forEach((P, k) => this.emitPass(k, P, owner));
    this.planes = this.rowInk = null;
    this.push([0x0C]);
  }

  endJob() {
    this.push([
      0x1B, 0x40,
      0x1B, 0x28, 0x52, 0x08, 0x00, 0x00, ...enc('REMOTE1'),
      ...enc('LD'), 0x00, 0x00, ...enc('JE'), 0x01, 0x00, 0x00,
      0x1B, 0x00, 0x00, 0x00,
    ]);
    this.flush();
  }
}
