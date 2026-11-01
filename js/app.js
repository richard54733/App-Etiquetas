/* app.js — interface do app Etiquetas */
import { db, getKV, setKV } from './db.js';
import { UsbPrinter, usbSupported, pickLanguage } from './usb.js';
import { printDocuments, describeLanguage } from './printjob.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let pdftools; // carregado sob demanda (pdf.js é grande)
const tools = async () => (pdftools ||= await import('./pdftools.js'));

const state = {
  items: [],          // catálogo + PDFs do usuário
  byId: new Map(),
  qty: {},            // id -> folhas
  order: [],          // ordem em que os itens entraram na lista
  settings: { color: true, paper: 'A4', language: 'auto', offsetX: 0, offsetY: 0, quality: 'normal' },
  history: [],
  query: '',
  logLines: [],
};

const log = (msg) => {
  const line = `${new Date().toLocaleTimeString('pt-BR')}  ${msg}`;
  state.logLines.push(line); if (state.logLines.length > 200) state.logLines.shift();
  const el = $('#techLog'); if (el) el.textContent = state.logLines.join('\n');
  console.log('[etiquetas]', msg);
};
const printer = new UsbPrinter(log);

/* ---------- nomes e tamanhos ---------- */
export function parseTitle(base) {
  let raw = base.replace(/\.pdf$/i, '').replace(/\s+pim$/i, '').replace(/\s+/g, ' ').trim();
  let code = null, size = null;
  let m = raw.match(/\s(\d{3})$/); if (m) { code = m[1]; raw = raw.slice(0, m.index).trim(); }
  m = raw.match(/\s(\d+(?:[.,]\d+)?)\s*(l|ml)$/i);
  if (m) { size = m[1].replace('.', ',') + (m[2].toLowerCase() === 'l' ? ' L' : ' ml'); raw = raw.slice(0, m.index).trim(); }
  const small = new Set(['de', 'do', 'da', 'com', 'para', 'e', 'p/']);
  const name = raw.toLowerCase().split(' ').map((w, i) => (i && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  return { name: name || base, size, code };
}
const sizeValue = (s) => { if (!s) return 0; const n = parseFloat(s.replace(',', '.')); return /ml/.test(s) ? n : n * 1000; };
const itemLabel = (it) => [it.name, it.size].filter(Boolean).join(' ');

/* ---------- carregamento ---------- */
async function loadCatalog() {
  const res = await fetch('catalog/catalog.json');
  const data = await res.json();
  const mine = await db.all('files').catch(() => []);
  const items = data.items.map((i) => ({ ...i, source: 'catalog' }));
  for (const f of mine) items.push({ id: f.id, name: f.name, size: f.size, code: f.code, thumb: f.thumb, pages: f.pages, source: 'mine', title: f.title });
  state.items = items;
  state.byId = new Map(items.map((i) => [i.id, i]));
}

async function getBytes(item) {
  if (item.source === 'mine') {
    const f = await db.get('files', item.id);
    return new Uint8Array(await f.blob.arrayBuffer());
  }
  const r = await fetch(item.file);
  if (!r.ok) throw new Error('Não consegui abrir ' + itemLabel(item));
  return new Uint8Array(await r.arrayBuffer());
}

/* ---------- grade ---------- */
function groups() {
  const q = norm(state.query).trim();
  const map = new Map();
  for (const it of state.items) {
    if (q) {
      const hay = norm(`${it.name} ${it.size || ''} ${it.code || ''} ${it.title || ''}`);
      if (!q.split(/\s+/).every((t) => hay.includes(t))) continue;
    }
    const key = norm(it.name) + (it.source === 'mine' ? '#mine' : '');
    if (!map.has(key)) map.set(key, { name: it.name, mine: it.source === 'mine', variants: [] });
    map.get(key).variants.push(it);
  }
  const list = [...map.values()];
  list.forEach((g) => g.variants.sort((a, b) => sizeValue(a.size) - sizeValue(b.size)));
  list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
  return list;
}

function stepperHTML(id, n) {
  return `<div class="stepper" data-id="${esc(id)}" data-zero="${n ? 'false' : 'true'}">
    <button type="button" class="minus" data-d="-1" aria-label="Tirar uma folha"><svg><use href="#i-minus"/></svg></button>
    <output aria-live="polite">${n}</output>
    <button type="button" class="plus" data-d="1" aria-label="Pôr uma folha"><svg><use href="#i-plus"/></svg></button>
  </div>`;
}

function renderGrid() {
  const gl = groups();
  const grid = $('#grid');
  $('#empty').hidden = gl.length > 0;
  let html = '', last = '';
  const showLetters = !state.query && gl.length > 12;
  for (const g of gl) {
    let L = norm(g.name).charAt(0).toUpperCase(); if (/[0-9]/.test(L)) L = '#';
    if (showLetters && L !== last) { html += `<h2 class="letter" id="letra-${L}">${esc(L)}</h2>`; last = L; }
    const any = g.variants.some((v) => state.qty[v.id]);
    const first = g.variants[0];
    html += `<article class="card${any ? ' has-qty' : ''}">
      <div class="card-thumb"><img src="${esc(first.thumb)}" alt="Etiqueta ${esc(g.name)}" loading="lazy" decoding="async"></div>
      <div class="card-body">
        <h3>${esc(g.name)}${g.mine ? '<span class="tag">meu PDF</span>' : ''}</h3>
        <ul class="variants">${g.variants.map((v) => `
          <li class="variant">
            <span class="v-name"><b>${esc(v.size || (g.variants.length > 1 ? itemLabel(v) : 'Folha'))}</b><small>${v.code ? 'cód. ' + esc(v.code) + ' · ' : ''}${v.source === 'catalog' ? '15 etiquetas por folha' : plural(v.pages || 1, 'página', 'páginas')}</small></span>
            ${stepperHTML(v.id, state.qty[v.id] || 0)}
          </li>`).join('')}
        </ul>
      </div>
    </article>`;
  }
  grid.innerHTML = html;
}

function updateSteppers(id) {
  const n = state.qty[id] || 0;
  $$(`.stepper[data-id="${CSS.escape(id)}"]`).forEach((s) => {
    s.dataset.zero = n ? 'false' : 'true';
    const o = s.querySelector('output'); o.textContent = n;
    o.classList.remove('bump'); void o.offsetWidth; o.classList.add('bump');
    const card = s.closest('.card');
    if (card) card.classList.toggle('has-qty', $$('.stepper', card).some((x) => x.dataset.zero === 'false'));
  });
}

/* ---------- lista (carrinho) ---------- */
const totalSheets = () => state.order.reduce((t, id) => t + (state.qty[id] || 0) * (state.byId.get(id)?.pages || 1), 0);
const cartEntries = () => state.order.filter((id) => state.qty[id] > 0 && state.byId.has(id)).map((id) => ({ item: state.byId.get(id), qty: state.qty[id] }));
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

function setQty(id, n, { from } = {}) {
  n = Math.max(0, Math.min(999, n | 0));
  const before = state.qty[id] || 0;
  if (n) { state.qty[id] = n; if (!state.order.includes(id)) state.order.push(id); }
  else { delete state.qty[id]; state.order = state.order.filter((x) => x !== id); }
  updateSteppers(id);
  renderCartBar(n > before);
  if (from && n > before) flyToCart(from);
  if ($('#dlgCart').open) renderCartList();
  persistCart();
}

let persistT;
function persistCart() { clearTimeout(persistT); persistT = setTimeout(() => setKV('cart', { qty: state.qty, order: state.order }), 250); }

function renderCartBar(bump) {
  const n = totalSheets();
  const bar = $('#cartBar');
  bar.dataset.empty = n ? 'false' : 'true';
  const c = $('#cartCount'); c.textContent = n;
  if (bump) { c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump'); }
  const kinds = cartEntries().length;
  $('#cartLabel').textContent = n ? plural(n, 'folha', 'folhas') : 'Lista vazia';
  $('#cartHint').textContent = n ? `${plural(kinds, 'etiqueta', 'etiquetas')} · toque para ver` : 'Toque em + nas etiquetas';
  $('#printBtn').disabled = !n;
  $('#dlgCart [data-action="print"] span').textContent = n ? `Imprimir ${plural(n, 'folha', 'folhas')}` : 'Imprimir';
}

function renderCartList() {
  const ul = $('#cartList');
  const entries = cartEntries();
  if (!entries.length) {
    ul.innerHTML = `<li class="empty-note">Sua lista está vazia.<br>Feche e toque em <b>+</b> nas etiquetas que quer imprimir.</li>`;
  } else {
    ul.innerHTML = entries.map(({ item, qty }) => `
      <li class="cart-item">
        <img src="${esc(item.thumb)}" alt="">
        <span class="ci-name"><b>${esc(item.name)}</b><small>${esc(item.size || '')}${item.code ? ' · cód. ' + esc(item.code) : ''}</small></span>
        ${stepperHTML(item.id, qty)}
      </li>`).join('');
  }
  const n = totalSheets();
  $('#cartTotal').textContent = n ? `Total: ${plural(n, 'folha', 'folhas')}` : '';
  $$('#dlgCart .sheet-actions .btn').forEach((b) => (b.disabled = !n));
}

function flyToCart(fromEl) {
  if (reduceMotion) return;
  const card = fromEl.closest('.card') || fromEl.closest('.cart-item');
  const img = card?.querySelector('img');
  const target = $('.cart-icon');
  if (!img || !target) return;
  const a = img.getBoundingClientRect(), b = target.getBoundingClientRect();
  const f = img.cloneNode();
  f.className = 'flyer';
  Object.assign(f.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px' });
  document.body.appendChild(f);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
  f.animate([
    { transform: 'translate(0,0) scale(1)', opacity: 1 },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 60}px) scale(.55) rotate(-6deg)`, opacity: 1, offset: 0.55 },
    { transform: `translate(${dx}px, ${dy}px) scale(.18) rotate(-12deg)`, opacity: 0.2 },
  ], { duration: 620, easing: 'cubic-bezier(.3,.7,.3,1)' }).onfinish = () => f.remove();
}

/* ---------- folhas (dialogs) ---------- */
function openSheet(id) {
  const d = $('#' + id);
  if (d.open) return d;
  $$('dialog.sheet[open]').forEach((o) => o !== d && o.close());
  d.showModal();
  return d;
}
function closeSheet(d) {
  if (!d.open) return;
  if (reduceMotion || !d.classList.contains('sheet')) { d.close(); return; }
  d.classList.add('closing');
  d.addEventListener('animationend', () => { d.classList.remove('closing'); d.close(); }, { once: true });
}
document.addEventListener('click', (e) => {
  const d = e.target.closest('dialog');
  if (e.target.matches('dialog.sheet')) { closeSheet(e.target); return; } // toque fora
  if (e.target.closest('[data-close]') && d) closeSheet(d);
});

/* ---------- aviso ---------- */
let toastT;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), action ? 6000 : 3200);
}

/* ---------- PDF único ---------- */
async function buildMergedPdf() {
  const { mergePdfs } = await tools();
  const entries = [];
  for (const { item, qty } of cartEntries()) entries.push({ bytes: await getBytes(item), qty, name: item.name });
  return mergePdfs(entries, 'Etiquetas ' + new Date().toLocaleDateString('pt-BR'));
}
function fileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Etiquetas ${p(d.getDate())}-${p(d.getMonth() + 1)} ${p(d.getHours())}h${p(d.getMinutes())} (${totalSheets()} folhas).pdf`;
}
function downloadBytes(bytes, name, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function sharePdf() {
  if (!totalSheets()) return;
  const busy = showBusy('Juntando as folhas…');
  try {
    const bytes = await buildMergedPdf();
    const file = new File([bytes], fileName(), { type: 'application/pdf' });
    busy.close();
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Etiquetas', text: `Etiquetas para imprimir (${plural(totalSheets(), 'folha', 'folhas')})` });
    } else {
      downloadBytes(bytes, file.name);
      toast('PDF salvo. Abra o WhatsApp e anexe o arquivo da pasta Downloads.');
    }
  } catch (e) {
    busy.close();
    if (e.name !== 'AbortError') toast('Não deu para compartilhar: ' + e.message);
  }
}
async function savePdf() {
  if (!totalSheets()) return;
  const busy = showBusy('Juntando as folhas…');
  try { const bytes = await buildMergedPdf(); downloadBytes(bytes, fileName()); toast('PDF salvo na pasta Downloads.'); }
  catch (e) { toast('Não consegui gerar o PDF: ' + e.message); }
  finally { busy.close(); }
}
function showBusy(text) {
  const d = $('#dlgPrint');
  const ring = $('#ring'); ring.className = 'ring busy'; ring.style.setProperty('--p', 0.25);
  $('#ringNum').textContent = '';
  $('#printPhase').textContent = text; $('#printDetail').textContent = ''; $('#printActions').innerHTML = '';
  if (!d.open) d.showModal();
  return { close: () => d.open && d.close() };
}

/* ---------- impressora ---------- */
function updatePrinterUI() {
  const pill = $('#printerPill');
  const st = !usbSupported ? 'none' : printer.connected ? 'on' : 'off';
  pill.dataset.state = st;
  $('.pill-text', pill).textContent = st === 'on' ? (printer.label || 'Conectada').replace(/^EPSON\s*/i, 'Epson ') : 'Impressora';
  $('#menuPrinterState').textContent = st === 'on' ? 'Conectada: ' + printer.label : usbSupported ? 'Não conectada' : 'Este navegador não liga no cabo';
  renderPrinterSheet();
}

function renderPrinterSheet() {
  const box = $('#printerStatus');
  if (!usbSupported) {
    box.innerHTML = `<div class="st-line"><span class="dot"></span>Sem conexão por cabo neste navegador</div>
      <p>Para imprimir direto pelo cabo, abra o app no <b>Google Chrome</b> de um celular Android (ou no Chrome/Edge do computador).</p>
      <p>Aqui você ainda pode <b>Salvar PDF</b> ou <b>Enviar no WhatsApp</b>.</p>`;
  } else if (printer.connected) {
    const lang = pickLanguage(printer.id || {}, state.settings.language);
    box.innerHTML = `<div class="st-line"><span class="dot on"></span>${esc(printer.label)}</div>
      <p>Pronta para imprimir pelo cabo · ${esc(describeLanguage(lang))}</p>
      <button class="btn ghost" type="button" data-action="disconnect">Desconectar</button>`;
  } else {
    box.innerHTML = `<div class="st-line"><span class="dot"></span>Nenhuma impressora conectada</div>
      <p>Ligue o cabo USB (com adaptador OTG) do celular na impressora, ligue a impressora e toque no botão abaixo.</p>
      <button class="btn primary big wide" type="button" data-action="connect"><svg><use href="#i-printer"/></svg>Conectar impressora</button>`;
  }
  $$('#dlgPrinter .seg').forEach((seg) => {
    const key = seg.dataset.setting;
    $$('button', seg).forEach((b) => b.setAttribute('aria-checked', String(String(state.settings[key]) === b.dataset.value)));
  });
  $$('#dlgPrinter [data-offset]').forEach((s) => {
    const v = state.settings[s.dataset.offset] || 0;
    s.querySelector('output').textContent = `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR')} mm`;
  });
}

async function connectPrinter() {
  if (!usbSupported) { openSheet('dlgPrinter'); return false; }
  try {
    await printer.request();
    await setKV('printerSeen', true);
    updatePrinterUI();
    toast('Impressora conectada: ' + printer.label);
    return true;
  } catch (e) {
    if (e.name === 'NotFoundError') { log('Nenhuma impressora escolhida.'); return false; }
    log('Erro ao conectar: ' + e.message);
    toast(e.name === 'SecurityError' ? 'O Android não deixou usar o cabo. Toque em Permitir quando ele perguntar.' : 'Não conectou: ' + e.message);
    return false;
  }
}

if (usbSupported) {
  navigator.usb.addEventListener('disconnect', (e) => { if (e.device === printer.device) { printer.epOut = null; log('Cabo desligado.'); updatePrinterUI(); } });
  navigator.usb.addEventListener('connect', async () => { if (!printer.connected && (await printer.reconnect())) { updatePrinterUI(); toast('Impressora conectada'); } });
}

/* ---------- impressão ---------- */
let printAbort = null;
async function startPrint({ sources, label, isTest = false }) {
  // 1) garantir impressora (o toque do usuário ainda vale para a janela de permissão)
  if (!usbSupported) { noUsbPrint(); return; }
  if (!printer.connected) {
    const ok = (await printer.reconnect()) || (await connectPrinter());
    updatePrinterUI();
    if (!ok) return;
  }
  const d = $('#dlgPrint');
  const ring = $('#ring');
  ring.className = 'ring'; ring.style.setProperty('--p', 0);
  const total = sources.reduce((t, s) => t + s.qty * (s.pages || 1), 0);
  $('#ringNum').textContent = '0';
  $('#printPhase').textContent = 'Preparando…';
  $('#printDetail').textContent = label;
  $('#printActions').innerHTML = `<button class="btn ghost" type="button" id="cancelPrint">Cancelar</button>`;
  if (!d.open) d.showModal();
  printAbort = new AbortController();
  $('#cancelPrint').onclick = () => printAbort.abort();
  wakeLock(true);
  const t0 = performance.now();
  try {
    const loaded = [];
    for (const s of sources) loaded.push({ bytes: s.bytes || (await getBytes(s.item)), qty: s.qty });
    const res = await printDocuments({
      sources: loaded, printer, settings: state.settings, signal: printAbort.signal,
      onStatus: ({ phase, done, total: tt }) => {
        ring.style.setProperty('--p', Math.min(1, done / tt));
        $('#ringNum').textContent = Math.floor(done);
        $('#printPhase').textContent = phase === 'prepare' ? 'Preparando a folha…' : 'Imprimindo…';
        $('#printDetail').textContent = `${Math.floor(done)} de ${plural(tt, 'folha', 'folhas')}`;
      },
    });
    log(`Enviado: ${res.sheets} folhas (${res.lang}) em ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    ring.className = 'ring done'; ring.style.setProperty('--p', 1);
    $('#printPhase').textContent = 'Pronto!';
    $('#printDetail').textContent = `${plural(res.sheets, 'folha enviada', 'folhas enviadas')} para a impressora.`;
    navigator.vibrate?.([30, 60, 30]);
    if (!isTest) {
      await addHistory();
      $('#printActions').innerHTML = `<button class="btn primary big" type="button" id="doneKeep">Concluir</button>
        <button class="btn ghost" type="button" id="doneClear">Concluir e esvaziar a lista</button>`;
      $('#doneKeep').onclick = () => d.close();
      $('#doneClear').onclick = () => { d.close(); clearCart(true); };
    } else {
      $('#printActions').innerHTML = `<button class="btn primary big" type="button" id="doneKeep">Concluir</button>`;
      $('#doneKeep').onclick = () => d.close();
    }
  } catch (e) {
    const cancelled = e.name === 'AbortError';
    log((cancelled ? 'Cancelado' : 'Erro: ') + (e.message || ''));
    ring.className = 'ring error';
    $('#printPhase').textContent = cancelled ? 'Impressão cancelada' : 'Não deu para imprimir';
    $('#printDetail').textContent = cancelled ? 'A impressora pode soltar a folha que estava no meio.' : friendlyError(e);
    $('#printActions').innerHTML = `${cancelled ? '' : '<button class="btn primary big" type="button" id="retry">Tentar de novo</button>'}
      <button class="btn soft" type="button" id="errPdf"><svg><use href="#i-download"/></svg>Salvar PDF</button>
      <button class="btn ghost" type="button" id="errClose">Fechar</button>`;
    $('#retry') && ($('#retry').onclick = () => { d.close(); startPrint({ sources, label, isTest }); });
    $('#errPdf').onclick = () => { d.close(); savePdf(); };
    $('#errClose').onclick = () => d.close();
    if (!printer.device?.opened) updatePrinterUI();
  } finally {
    wakeLock(false);
    printAbort = null;
  }
}

function friendlyError(e) {
  const m = e.message || '';
  if (/disconnected|desconect|NetworkError|No device/i.test(m)) return 'O cabo soltou ou a impressora desligou. Confira o cabo e tente de novo.';
  if (/stall|parou/i.test(m)) return 'A impressora parou. Veja se tem papel e se a luz de erro está piscando.';
  return m;
}

function noUsbPrint() {
  const d = $('#dlgPrint');
  const ring = $('#ring'); ring.className = 'ring error'; ring.style.setProperty('--p', 0);
  $('#ringNum').textContent = '';
  $('#printPhase').textContent = 'Este navegador não liga no cabo';
  $('#printDetail').textContent = 'Use o Google Chrome no Android para imprimir direto. Por aqui, você pode enviar o PDF pronto.';
  $('#printActions').innerHTML = `<button class="btn whatsapp big" type="button" id="nuShare"><svg><use href="#i-share"/></svg>Enviar no WhatsApp</button>
    <button class="btn soft" type="button" id="nuSave"><svg><use href="#i-download"/></svg>Salvar PDF</button>
    <button class="btn ghost" type="button" id="nuClose">Fechar</button>`;
  if (!d.open) d.showModal();
  $('#nuShare').onclick = () => { d.close(); sharePdf(); };
  $('#nuSave').onclick = () => { d.close(); savePdf(); };
  $('#nuClose').onclick = () => d.close();
}

let wl;
async function wakeLock(on) {
  try { if (on && 'wakeLock' in navigator) wl = await navigator.wakeLock.request('screen'); else { await wl?.release(); wl = null; } } catch {}
}

function printCart() {
  const entries = cartEntries();
  if (!entries.length) return;
  closeSheet($('#dlgCart'));
  startPrint({
    sources: entries.map(({ item, qty }) => ({ item, qty, pages: item.pages || 1 })),
    label: entries.map(({ item, qty }) => `${qty}× ${itemLabel(item)}`).join(', '),
  });
}

async function printTestPage() {
  const { testPagePdf } = await tools();
  const bytes = await testPagePdf(state.settings.paper);
  closeSheet($('#dlgPrinter'));
  startPrint({ sources: [{ bytes, qty: 1, pages: 1 }], label: 'Página de teste', isTest: true });
}

/** Gera os bytes exatos que iriam para a impressora (diagnóstico) */
async function savePrn(sources) {
  const chunks = [];
  const fake = { id: printer.id || {}, write: async (u8) => { chunks.push(u8.slice()); } };
  const loaded = [];
  for (const s of sources) loaded.push({ bytes: s.bytes || (await getBytes(s.item)), qty: s.qty });
  const res = await printDocuments({ sources: loaded, printer: fake, settings: state.settings });
  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  return { blob, lang: res.lang };
}
window.__etiquetas = { savePrn, state, setQty, parseTitle, printer };

/* ---------- histórico ---------- */
async function addHistory() {
  const entries = cartEntries();
  const rec = { id: Date.now(), date: new Date().toISOString(), sheets: totalSheets(), items: entries.map(({ item, qty }) => ({ id: item.id, qty, label: itemLabel(item) })) };
  state.history.unshift(rec);
  state.history = state.history.slice(0, 50);
  await setKV('history', state.history);
  renderAgain();
}
function summary(rec) { return rec.items.map((i) => `${i.qty}× ${i.label}`).join(', '); }
function renderAgain() {
  const last = state.history[0];
  const box = $('#again');
  if (!last) { box.hidden = true; return; }
  box.hidden = false;
  $('#againSummary').textContent = summary(last);
}
function loadIntoCart(rec, replace = true) {
  if (replace) { state.qty = {}; state.order = []; }
  let missing = 0;
  for (const i of rec.items) {
    if (!state.byId.has(i.id)) { missing++; continue; }
    state.qty[i.id] = (replace ? 0 : state.qty[i.id] || 0) + i.qty;
    if (!state.order.includes(i.id)) state.order.push(i.id);
  }
  renderGrid(); renderCartBar(true); persistCart();
  if (missing) toast(`${missing} etiqueta(s) daquela lista não existem mais.`);
}
function renderHistory() {
  const ul = $('#historyList');
  if (!state.history.length) { ul.innerHTML = '<li class="empty-note">Ainda não há impressões. Elas aparecem aqui depois da primeira.</li>'; return; }
  ul.innerHTML = state.history.map((r, i) => {
    const d = new Date(r.date);
    return `<li class="history-item">
      <div class="h-top"><span>${d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span><span>${plural(r.sheets, 'folha', 'folhas')}</span></div>
      <p>${esc(summary(r))}</p>
      <div class="row2"><button class="btn primary" type="button" data-h="print" data-i="${i}"><svg><use href="#i-printer"/></svg>Imprimir de novo</button>
      <button class="btn soft" type="button" data-h="load" data-i="${i}">Pôr na lista</button></div>
    </li>`;
  }).join('');
}

function clearCart(silent) {
  const backup = { qty: { ...state.qty }, order: [...state.order] };
  state.qty = {}; state.order = [];
  renderGrid(); renderCartBar(); renderCartList(); persistCart();
  if (!silent) toast('Lista esvaziada.', { label: 'Desfazer', run: () => { state.qty = backup.qty; state.order = backup.order; renderGrid(); renderCartBar(); persistCart(); } });
}

/* ---------- meus PDFs ---------- */
async function importFiles(files) {
  const { makeThumb } = await tools();
  let ok = 0;
  for (const f of files) {
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) continue;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const { thumb, pages } = await makeThumb(bytes);
      const meta = parseTitle(f.name);
      const rec = { id: 'meu-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...meta, title: f.name.replace(/\.pdf$/i, ''), thumb, pages, blob: new Blob([bytes], { type: 'application/pdf' }), added: Date.now() };
      await db.put('files', rec);
      ok++;
    } catch (e) { log('Falha ao importar ' + f.name + ': ' + e.message); toast('Não consegui ler ' + f.name); }
  }
  await loadCatalog(); renderGrid(); renderMine();
  if (ok) toast(`${plural(ok, 'PDF adicionado', 'PDFs adicionados')} à lista.`);
}
async function renderMine() {
  const mine = state.items.filter((i) => i.source === 'mine');
  $('#myList').innerHTML = mine.length ? mine.map((m) => `<li class="my-item"><img src="${esc(m.thumb)}" alt=""><span>${esc(m.title || itemLabel(m))}</span>
    <button class="icon-btn" type="button" data-del="${esc(m.id)}" aria-label="Apagar ${esc(m.title)}"><svg><use href="#i-trash"/></svg></button></li>`).join('')
    : '<li class="empty-note">Você ainda não adicionou PDFs.</li>';
}

/* ---------- tour ---------- */
const TOUR = [
  { sel: '.search', title: 'Procure a etiqueta', text: 'Escreva o nome do produto, como “cloro” ou “amaciante”. Ou role a tela para ver todas.' },
  { sel: '.card .plus', title: 'Toque no + verde', text: 'Cada toque é uma folha a mais daquela etiqueta. O − tira uma folha.' },
  { sel: '#openCart', title: 'Sua lista fica aqui', text: 'Mostra quantas folhas você escolheu. Toque para conferir, enviar no WhatsApp ou salvar o PDF.' },
  { sel: '#printBtn', title: 'Ligue o cabo e imprima', text: 'Conecte o celular na impressora com o cabo OTG e toque em Imprimir. Tudo sai de uma vez, já juntado.' },
  { sel: '#menuBtn', title: 'Menu', text: 'Aqui ficam a impressora, as impressões anteriores, os seus PDFs e este passo a passo.' },
];
let tourI = 0;
function startTour() {
  tourI = 0; $('#tour').hidden = false; window.scrollTo({ top: 0 }); showTourStep();
}
function showTourStep() {
  const s = TOUR[tourI];
  const el = $(s.sel);
  if (!el) { tourI++; if (tourI < TOUR.length) showTourStep(); else endTour(); return; }
  el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  setTimeout(() => {
    const r = el.getBoundingClientRect(); const pad = 8;
    Object.assign($('#tourSpot').style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    const card = $('.tour-card');
    const below = r.top < innerHeight / 2;
    card.style.top = below ? Math.min(innerHeight - 260, r.bottom + 24) + 'px' : 'auto';
    card.style.bottom = below ? 'auto' : innerHeight - r.top + 24 + 'px';
  }, reduceMotion ? 0 : 320);
  $('#tourStep').textContent = `Passo ${tourI + 1} de ${TOUR.length}`;
  $('#tourTitle').textContent = s.title; $('#tourText').textContent = s.text;
  $('#tourNext').textContent = tourI === TOUR.length - 1 ? 'Começar' : 'Próximo';
  $('#tourNext').focus();
}
function endTour() { $('#tour').hidden = true; setKV('tourDone', true); }
$('#tourNext').onclick = () => { tourI++; if (tourI >= TOUR.length) endTour(); else showTourStep(); };
$('#tourSkip').onclick = endTour;

/* ---------- instalação (tela inicial) ---------- */
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#menuInstall').hidden = false; });
addEventListener('appinstalled', () => { $('#menuInstall').hidden = true; toast('Pronto! O app está na tela inicial.'); });

/* ---------- eventos ---------- */
document.addEventListener('click', async (e) => {
  const st = e.target.closest('.stepper[data-id] button');
  if (st) {
    const s = st.closest('.stepper'); const id = s.dataset.id;
    const d = +st.dataset.d;
    if (d > 0) navigator.vibrate?.(8);
    setQty(id, (state.qty[id] || 0) + d, { from: d > 0 && s.closest('.card') ? st : null });
    return;
  }
  const off = e.target.closest('[data-offset] button');
  if (off) {
    const key = off.closest('[data-offset]').dataset.offset;
    state.settings[key] = Math.round(((state.settings[key] || 0) + +off.dataset.d) * 2) / 2;
    state.settings[key] = Math.max(-10, Math.min(10, state.settings[key]));
    setKV('settings', state.settings); renderPrinterSheet(); return;
  }
  const seg = e.target.closest('.seg button');
  if (seg) {
    const key = seg.closest('.seg').dataset.setting; let v = seg.dataset.value;
    if (v === 'true' || v === 'false') v = v === 'true';
    state.settings[key] = v; setKV('settings', state.settings); renderPrinterSheet(); updatePrinterUI(); return;
  }
  const h = e.target.closest('[data-h]');
  if (h) {
    const rec = state.history[+h.dataset.i];
    closeSheet($('#dlgHistory'));
    loadIntoCart(rec, true);
    if (h.dataset.h === 'print') printCart(); else toast('Lista carregada. Confira e toque em Imprimir.');
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    await db.del('files', del.dataset.del);
    setQty(del.dataset.del, 0);
    await loadCatalog(); renderGrid(); renderMine(); toast('PDF apagado.'); return;
  }
  const a = e.target.closest('[data-action]');
  if (!a) return;
  switch (a.dataset.action) {
    case 'print': printCart(); break;
    case 'share': sharePdf(); break;
    case 'download': savePdf(); break;
    case 'clear': closeSheet($('#dlgCart')); clearCart(); break;
    case 'printer': openSheet('dlgPrinter'); break;
    case 'connect': connectPrinter(); break;
    case 'disconnect': await printer.close(); updatePrinterUI(); break;
    case 'history': renderHistory(); openSheet('dlgHistory'); break;
    case 'add-pdf': renderMine(); openSheet('dlgAdd'); break;
    case 'install': closeSheet($('#dlgMenu')); if (installEvt) { installEvt.prompt(); installEvt = null; } break;
    case 'tour': closeSheet($('#dlgMenu')); setTimeout(startTour, 300); break;
    case 'testpage': printTestPage(); break;
    case 'save-prn': {
      try {
        const entries = cartEntries();
        let sources;
        if (entries.length) sources = entries.map(({ item, qty }) => ({ item, qty }));
        else { const { testPagePdf } = await tools(); sources = [{ bytes: await testPagePdf(state.settings.paper), qty: 1 }]; }
        const { blob, lang } = await savePrn(sources);
        downloadBytes(await blob.arrayBuffer(), `diagnostico-${lang}.prn`, 'application/octet-stream');
        log(`Arquivo .prn gerado (${(blob.size / 1024).toFixed(0)} KB, ${lang}).`);
      } catch (err) { log('Falha no .prn: ' + err.message); }
      break;
    }
  }
});

$('#printBtn').addEventListener('click', printCart);
$('#openCart').addEventListener('click', () => { renderCartList(); openSheet('dlgCart'); });
$('#menuBtn').addEventListener('click', () => openSheet('dlgMenu'));
$('#printerPill').addEventListener('click', () => { renderPrinterSheet(); openSheet('dlgPrinter'); });
$('#againBtn').addEventListener('click', () => { loadIntoCart(state.history[0], true); renderCartList(); openSheet('dlgCart'); });
$('#fileInput').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
let qT;
$('#q').addEventListener('input', (e) => { state.query = e.target.value; $('#qClear').hidden = !state.query; clearTimeout(qT); qT = setTimeout(renderGrid, 90); });
$('#qClear').addEventListener('click', () => { $('#q').value = ''; state.query = ''; $('#qClear').hidden = true; renderGrid(); $('#q').focus(); });

/* ---------- offline (service worker) ---------- */
async function setupOffline() {
  if (!('serviceWorker' in navigator)) { $('#offlineNote').textContent = 'Este navegador não guarda o app para uso sem internet.'; return; }
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'precache') {
        const { done, total } = e.data;
        $('#offlineNote').textContent = done >= total ? `✓ Todas as ${total} etiquetas estão salvas para usar sem internet.` : `Salvando etiquetas para usar sem internet… ${done} de ${total}`;
      }
    });
    const files = state.items.filter((i) => i.source === 'catalog').map((i) => i.file);
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'precache', files });
  } catch (e) { log('Service worker: ' + e.message); }
}

/* ---------- início ---------- */
(async function init() {
  $('#grid').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  const [settings, cart, history] = await Promise.all([getKV('settings', null), getKV('cart', null), getKV('history', [])]);
  if (settings) Object.assign(state.settings, settings);
  state.history = history || [];
  try { await loadCatalog(); } catch (e) { $('#grid').innerHTML = `<p class="empty-note">Não consegui carregar as etiquetas. Verifique a internet e abra de novo.</p>`; log(e.message); return; }
  if (cart) { state.qty = Object.fromEntries(Object.entries(cart.qty || {}).filter(([id]) => state.byId.has(id))); state.order = (cart.order || []).filter((id) => state.qty[id]); }
  renderGrid(); renderCartBar(); renderAgain();
  if (usbSupported) { await printer.reconnect(); }
  updatePrinterUI();
  setupOffline();
  if (!(await getKV('tourDone', false)) && !/notour/.test(location.search)) setTimeout(startTour, 600);
})();
