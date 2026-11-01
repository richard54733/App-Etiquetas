/*
 * usb.js — Conexão direta com a impressora pelo cabo USB (OTG) usando WebUSB.
 * Funciona no Chrome para Android e no Chrome/Edge do computador.
 */

const EPSON_VENDOR = 0x04b8;

export const usbSupported = typeof navigator !== 'undefined' && 'usb' in navigator;

export function parseDeviceId(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim().toUpperCase()] = part.slice(i + 1).trim();
  }
  out.MFG = out.MFG || out.MANUFACTURER || '';
  out.MDL = out.MDL || out.MODEL || '';
  out.CMD = out.CMD || out['COMMAND SET'] || '';
  return out;
}

/** Decide a linguagem de impressão a partir do Device ID (CMD:...) e do modelo */
export function pickLanguage(id, override = 'auto') {
  if (override && override !== 'auto') return override;
  const cmd = (id.CMD || '').toUpperCase();
  if (/ESCPR/.test(cmd)) return 'escpr';
  return 'escp2'; // L210 / L110 / L355 e similares (ESC/P2 raster)
}

export class UsbPrinter {
  constructor(log = () => {}) {
    this.device = null;
    this.iface = null;
    this.alt = 0;
    this.epOut = null;
    this.epIn = null;
    this.id = null;
    this.log = log;
  }

  get connected() { return !!(this.device && this.device.opened && this.epOut); }

  get label() {
    if (!this.device) return '';
    const mdl = this.id?.MDL || this.device.productName || 'Impressora USB';
    const mfg = this.id?.MFG || this.device.manufacturerName || '';
    return /epson/i.test(mdl) ? mdl : `${mfg} ${mdl}`.trim();
  }

  /** Abre a janela do sistema para escolher a impressora (precisa de um toque do usuário) */
  async request() {
    const device = await navigator.usb.requestDevice({
      filters: [{ vendorId: EPSON_VENDOR }, { classCode: 7 }],
    });
    await this.open(device);
    return this;
  }

  /** Reconecta sem perguntar, se a impressora já foi autorizada antes */
  async reconnect() {
    if (!usbSupported) return false;
    const list = await navigator.usb.getDevices();
    const dev = list.find((d) => d.vendorId === EPSON_VENDOR) || list[0];
    if (!dev) return false;
    try { await this.open(dev); return true; } catch (e) { this.log('Reconexão falhou: ' + e.message); return false; }
  }

  async open(device) {
    this.device = device;
    if (!device.opened) await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    // procura a interface de classe "impressora" (7), preferindo a bidirecional (protocolo 2)
    let best = null;
    for (const intf of device.configuration.interfaces) {
      for (const a of intf.alternates) {
        if (a.interfaceClass !== 7) continue;
        const out = a.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
        if (!out) continue;
        const score = a.interfaceProtocol === 2 ? 2 : 1;
        if (!best || score > best.score) best = { intf, a, out, score };
      }
    }
    if (!best) throw new Error('Este aparelho USB não parece ser uma impressora.');
    this.iface = best.intf.interfaceNumber;
    this.alt = best.a.alternateSetting;
    await device.claimInterface(this.iface);
    if (best.intf.alternates.length > 1) {
      try { await device.selectAlternateInterface(this.iface, this.alt); } catch (e) { this.log('Alt: ' + e.message); }
    }
    this.epOut = best.out.endpointNumber;
    this.epIn = best.a.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk')?.endpointNumber ?? null;
    this.packet = best.out.packetSize || 64;
    this.id = await this.readDeviceId().catch((e) => { this.log('Device ID: ' + e.message); return {}; });
    this.log(`Conectado: ${this.label} | interface ${this.iface}/${this.alt} | saída EP${this.epOut} | CMD: ${this.id.CMD || '?'}`);
  }

  /** Lê o IEEE-1284 Device ID (requisição GET_DEVICE_ID da classe impressora) */
  async readDeviceId() {
    const r = await this.device.controlTransferIn({
      requestType: 'class', recipient: 'interface', request: 0,
      value: this.device.configuration.configurationValue - 1,
      index: (this.iface << 8) | this.alt,
    }, 1024);
    if (r.status !== 'ok' || !r.data) throw new Error('sem resposta');
    const len = (r.data.getUint8(0) << 8) | r.data.getUint8(1);
    const bytes = new Uint8Array(r.data.buffer, r.data.byteOffset + 2, Math.max(0, Math.min(len, r.data.byteLength) - 2));
    const text = new TextDecoder('latin1').decode(bytes);
    const id = parseDeviceId(text);
    id.raw = text;
    return id;
  }

  /** Envia bytes para a impressora em blocos */
  async write(data) {
    if (!this.connected) throw new Error('Impressora desconectada');
    const CH = 16384;
    let stalls = 0;
    for (let o = 0; o < data.length;) {
      const part = data.subarray(o, Math.min(o + CH, data.length));
      const r = await this.device.transferOut(this.epOut, part);
      if (r.status === 'stall') {
        if (++stalls > 5) throw new Error('A impressora parou de aceitar dados (verifique papel e tinta).');
        await this.device.clearHalt('out', this.epOut);
        continue; // tenta o mesmo bloco de novo
      }
      if (r.status !== 'ok') throw new Error('Falha no envio USB: ' + r.status);
      o += r.bytesWritten || part.length;
    }
  }

  async close() {
    try { if (this.device?.opened) { await this.device.releaseInterface(this.iface); await this.device.close(); } } catch {}
    this.epOut = null;
  }
}
