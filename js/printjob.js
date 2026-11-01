/*
 * printjob.js — transforma os PDFs em comandos da impressora e envia pelo USB.
 * Cada página diferente é rasterizada e codificada UMA vez; as cópias reaproveitam
 * os mesmos bytes, então 20 folhas iguais custam quase o mesmo que 1.
 */
import { EscprJob, MARGIN } from './escpr.js';
import { Escp2Job, L210_PAPERS } from './escp2.js';
import { openPdf, rasterizePage } from './pdftools.js';
import { pickLanguage } from './usb.js';

const PX_PER_MM = 360 / 25.4;

export function describeLanguage(lang) {
  return lang === 'escpr' ? 'ESC/P-R (Epson moderno)' : 'ESC/P2 raster (Epson L210 e família)';
}

/**
 * @param {object} o
 * @param {{bytes:Uint8Array, qty:number}[]} o.sources
 * @param {{write:(u8:Uint8Array)=>Promise<void>, id?:object}} o.printer
 * @param {{paper:string,color:boolean,quality:string,language:string,offsetX:number,offsetY:number}} o.settings
 * @param {(s:{phase:string, done:number, total:number, detail?:string})=>void} o.onStatus
 */
export async function printDocuments({ sources, printer, settings, onStatus = () => {}, signal }) {
  const lang = pickLanguage(printer.id || {}, settings.language);
  const color = settings.color !== false;
  let collected = [];
  const sink = (u8) => collected.push(u8);
  const take = () => { const parts = collected; collected = []; return concat(parts); };

  let job, offX, offY;
  if (lang === 'escpr') {
    job = new EscprJob(sink, { paper: settings.paper || 'A4', quality: settings.quality || 'normal', mono: !color });
    offX = MARGIN; offY = MARGIN;
  } else {
    job = new Escp2Job(sink, { paper: L210_PAPERS[settings.paper] ? settings.paper : 'A4', color });
    offX = L210_PAPERS[settings.paper]?.left ?? 45; offY = 0;
  }
  offX += Math.round((settings.offsetX || 0) * PX_PER_MM);
  offY += Math.round((settings.offsetY || 0) * PX_PER_MM);

  // total de folhas para o progresso
  const docs = [];
  let totalSheets = 0;
  for (const s of sources) {
    if (!s.qty) continue;
    const doc = await openPdf(s.bytes);
    docs.push({ doc, qty: s.qty, bodies: [] });
    totalSheets += doc.numPages * s.qty;
  }
  if (!totalSheets) throw new Error('Nada para imprimir.');

  job.startJob(); job.flush();
  await printer.write(take());

  let sent = 0;
  try {
    for (const d of docs) {
      for (let copy = 0; copy < d.qty; copy++) {
        for (let p = 1; p <= d.doc.numPages; p++) {
          if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
          if (!d.bodies[p]) {
            onStatus({ phase: 'prepare', done: sent, total: totalSheets });
            job.startPage();
            await rasterizePage(d.doc, p, {
              dpi: 360, width: job.width, height: job.height, offX, offY, gray: !color,
              onRow: (y, row) => job.line(y, row),
              onProgress: (f) => onStatus({ phase: 'prepare', done: sent + f * 0.5, total: totalSheets }),
            });
            job.endPage(true); job.flush();
            d.bodies[p] = take();
          }
          onStatus({ phase: 'send', done: sent + 0.5, total: totalSheets });
          await printer.write(d.bodies[p]);
          sent++;
          onStatus({ phase: 'send', done: sent, total: totalSheets });
        }
      }
    }
  } finally {
    // sempre encerra o trabalho, para a impressora não ficar presa
    job.endJob();
    try { await printer.write(take()); } catch {}
    docs.forEach((d) => d.doc.destroy());
  }
  return { sheets: sent, lang };
}

function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
