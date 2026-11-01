/*
 * escpr.js — Gerador da linguagem Epson ESC/P-R em JavaScript puro.
 *
 * Portado do driver oficial e aberto da Epson "epson-inkjet-printer-escpr"
 * (lib/epson-escpr-api.c, licença GPL-2.0+). Gera exatamente a mesma
 * sequência de bytes que o driver Linux oficial envia para impressoras
 * jato de tinta Epson (linha EcoTank L-series, entre outras).
 *
 * Estrutura de um trabalho:
 *   ExitPacketMode, ESC @, REMOTE1 (TI, JS, JH, HD, PP), sai do remote,
 *   ESC(R ESCPR, "setq" (qualidade), "setj" (papel/margens),
 *   para cada página: "sttp", linhas "dsnd" (RGB comprimido RLE), "endp"
 *   "endj", ESC @, REMOTE1 JE, sai do remote.
 *
 * Todas as medidas internas estão em pontos de 1/360 polegada.
 */

export const PAPERS = {
  // id ESC/P-R, papel (largura/altura) e área imprimível com margem de 3 mm, a 360 dpi
  A4:     { id: 0,  name: 'A4 (210×297 mm)',      w: 2976, h: 4209, pw: 2892, ph: 4125 },
  LETTER: { id: 1,  name: 'Carta (216×279 mm)',   w: 3060, h: 3960, pw: 2976, ph: 3876 },
  A5:     { id: 3,  name: 'A5 (148×210 mm)',      w: 2098, h: 2976, pw: 2014, ph: 2892 },
  A6:     { id: 4,  name: 'A6 (105×148 mm)',      w: 1488, h: 2098, pw: 1404, ph: 2014 },
  P10X15: { id: 13, name: '10×15 cm (4×6")',      w: 1417, h: 2125, pw: 1333, ph: 2041 },
};

export const MARGIN = 42; // 3 mm a 360 dpi (EPS_BORDERS_MARGIN_360)
export const DPI = 360;

const enc = (s) => Array.from(s, (c) => c.charCodeAt(0));

const EXIT_PACKET_MODE = [
  0x00, 0x00, 0x00, 0x1B, 0x01, 0x40, 0x45, 0x4A, 0x4C, 0x20,
  0x31, 0x32, 0x38, 0x34, 0x2E, 0x34, 0x0A, 0x40, 0x45, 0x4A,
  0x4C, 0x20, 0x20, 0x20, 0x20, 0x20, 0x0A,
];
const INIT_PRINTER = [0x1B, 0x40];
const ENTER_REMOTE = [0x1B, 0x28, 0x52, 0x08, 0x00, 0x00, ...enc('REMOTE1')];
const EXIT_REMOTE = [0x1B, 0x00, 0x00, 0x00];
const ESCPR_MODE = [0x1B, 0x28, 0x52, 0x06, 0x00, 0x00, ...enc('ESCPR')];

const be16 = (v) => [(v >> 8) & 0xFF, v & 0xFF];
const be32 = (v) => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
const le32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

/** Monta um comando ESC/P-R: ESC + classe + tamanho(LE32) + nome(4) + parâmetros */
function cmd(cls, name, params = []) {
  return [0x1B, cls.charCodeAt(0), ...le32(params.length), ...enc(name), ...params];
}

/**
 * Compressão RLE idêntica à RunLengthEncode() do driver Epson.
 * src: Uint8Array com `pixels * bpp` bytes. Retorna { data, compressed }.
 */
export function runLengthEncode(src, pixels, bpp, out) {
  const width = pixels * bpp;
  const dst = out && out.length >= width + 2 ? out : new Uint8Array(width + 2 + Math.ceil(pixels / 128) * 4);
  let s = 0, srcCnt = 0, d = 0, ret = 0;
  const same = (a, b) => {
    for (let k = 0; k < bpp; k++) if (src[a + k] !== src[b + k]) return false;
    return true;
  };
  let ok = true;
  while (srcCnt < pixels) {
    if (srcCnt + 1 < pixels && same(s, s + bpp)) {
      let rep = 2;
      while (srcCnt + rep < pixels && rep < 0x81 && same(s + (rep - 1) * bpp, s + rep * bpp)) rep++;
      ret += 1 + bpp;
      if (ret > width) { ok = false; break; }
      dst[d++] = (0xFF - rep + 2) & 0xFF;
      for (let k = 0; k < bpp; k++) dst[d++] = src[s + k];
      srcCnt += rep;
      s += bpp * rep;
    } else {
      let rep = 1;
      while (srcCnt + rep + 1 < pixels && rep < 0x80 && !same(s + rep * bpp, s + (rep + 1) * bpp)) rep++;
      ret += 1 + rep * bpp;
      if (ret > width) { ok = false; break; }
      dst[d++] = rep - 1;
      const n = rep * bpp;
      for (let k = 0; k < n; k++) dst[d++] = src[s + k];
      srcCnt += rep;
      s += n;
    }
  }
  if (!ok) return { data: src.subarray(0, width), compressed: false };
  return { data: dst.subarray(0, ret), compressed: true };
}

/**
 * Gera um trabalho de impressão ESC/P-R. Os bytes são entregues ao callback
 * `sink(Uint8Array)` em blocos, para serem enviados pelo USB conforme são gerados.
 */
export class EscprJob {
  /**
   * @param {object} o
   * @param {string} o.paper   chave de PAPERS (padrão 'A4')
   * @param {'draft'|'normal'|'high'} o.quality
   * @param {boolean} o.mono   true = escala de cinza (economiza tinta colorida)
   * @param {number} o.mediaType 0 = papel comum
   * @param {number} o.platform  byte HD (0x04 = linux, igual ao driver oficial)
   * @param {Date|null} o.time   data/hora para o comando TI (null = omite)
   */
  constructor(sink, o = {}) {
    this.sink = sink;
    this.paper = PAPERS[o.paper || 'A4'];
    this.quality = o.quality || 'normal';
    this.mono = !!o.mono;
    this.mediaType = o.mediaType ?? 0;
    this.platform = o.platform ?? 0x04;
    this.time = o.time === undefined ? new Date() : o.time;
    this.paperSource = o.paperSource ?? 'auto';
    this.buf = [];
    this.pending = 0;
    this.pageOpen = false;
    this.linesInPage = 0;
    this.rleBuf = new Uint8Array(this.paper.pw * 3 + 64);
  }

  get width() { return this.paper.pw; }
  get height() { return this.paper.ph; }

  push(bytes) {
    this.buf.push(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
    this.pending += bytes.length;
    if (this.pending >= 64 * 1024) this.flush();
  }

  flush() {
    if (!this.pending) return;
    const out = new Uint8Array(this.pending);
    let o = 0;
    for (const b of this.buf) { out.set(b, o); o += b.length; }
    this.buf = []; this.pending = 0;
    this.sink(out);
  }

  startJob() {
    const p = this.paper;
    const b = [];
    b.push(...EXIT_PACKET_MODE, ...INIT_PRINTER, ...ENTER_REMOTE);
    if (this.time) {
      const t = this.time;
      b.push(...enc('TI'), 0x08, 0x00, 0x00, ...be16(t.getFullYear()),
        t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds());
    }
    b.push(...enc('JS'), 0x04, 0x00, 0x00, 0x00, 0x00, 0x00);
    b.push(...enc('JH'), 0x0e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...enc('ESCPRLib'));
    b.push(...enc('HD'), 0x03, 0x00, 0x00, 0x03, this.platform & 0xFF);
    const pp = { auto: [0x01, 0xFF], rear: [0x01, 0x00], manual: [0x02, 0x00] }[this.paperSource] || [0x01, 0xFF];
    b.push(...enc('PP'), 0x03, 0x00, 0x00, ...pp);
    b.push(...EXIT_REMOTE, ...ESCPR_MODE);
    // setq: tipo de mídia, qualidade, modo de cor, brilho, contraste, saturação, plano de cor, paleta(2)
    const q = { draft: 0, normal: 1, high: 2 }[this.quality] ?? 1;
    b.push(...cmd('q', 'setq', [this.mediaType & 0xFF, q, this.mono ? 1 : 0, 0, 0, 0, 0, 0x00, 0x00]));
    // setj: papel W/H (BE32), margem topo/esq (BE16), área imprimível W/H (BE32), resolução (0=360), direção
    b.push(...cmd('j', 'setj', [
      ...be32(p.w), ...be32(p.h), ...be16(MARGIN), ...be16(MARGIN),
      ...be32(p.pw), ...be32(p.ph), 0x00, 0x00,
    ]));
    this.push(b);
  }

  startPage() {
    // igual ao filtro oficial do CUPS: "sttp" seguido de "setn" (valor 1, como o wrapper do CUPS)
    this.push([...cmd('p', 'sttp'), ...cmd('p', 'setn', [1])]);
    this.pageOpen = true;
    this.linesInPage = 0;
  }

  /**
   * Envia uma linha RGB (Uint8Array, width*3 bytes) na posição y.
   * Linhas totalmente brancas são puladas, como faz o driver oficial.
   */
  line(y, rgb, x = 0, skipWhite = true) {
    const pixels = Math.min(rgb.length / 3, this.paper.pw);
    if (skipWhite) {
      let white = true;
      for (let i = 0; i < pixels * 3; i++) if (rgb[i] !== 0xFF) { white = false; break; }
      if (white) return;
    }
    const { data, compressed } = runLengthEncode(rgb, pixels, 3, this.rleBuf);
    const head = [0x1B, 0x64, ...le32(7 + data.length), 0x64, 0x73, 0x6E, 0x64,
      ...be16(x), ...be16(y), compressed ? 1 : 0, ...be16(data.length)];
    this.push(head);
    this.push(data.slice());
    this.linesInPage++;
  }

  endPage(hasNext) {
    if (this.linesInPage === 0) {
      // página em branco: o driver manda uma faixa branca mínima
      const white = new Uint8Array(3).fill(0xFF);
      this.line(0, white, 0, false);
    }
    // o filtro oficial sempre envia 0 aqui (sem duplex)
    this.push(cmd('p', 'endp', [0]));
    this.pageOpen = false;
  }

  endJob() {
    this.push([
      ...cmd('j', 'endj'),
      ...INIT_PRINTER, ...ENTER_REMOTE,
      ...enc('JE'), 0x01, 0x00, 0x00,
      ...EXIT_REMOTE,
    ]);
    this.flush();
  }
}
