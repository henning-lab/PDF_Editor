// CCITT Group 4 (ITU-T T.6) Encoder für Schwarz-Weiß-Bilder.
// Verlustfrei und sehr kompakt, wird von jedem PDF-Leser unterstützt (Filter /CCITTFaxDecode, K -1).

const WT = ['00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111', '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101', '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100', '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010', '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000', '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010', '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000', '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100'];
const WM = ['11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101', '01101000', '01100111', '011001100', '011001101', '011010010', '011010011', '011010100', '011010101', '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000', '010011001', '010011010', '011000', '010011011'];
const BT = ['0000110111', '010', '11', '10', '011', '0011', '0010', '00011', '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000', '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000', '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001', '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111', '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111', '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111', '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111'];
const BM = ['0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100', '0000001101101', '0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100', '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010', '0000001011011', '0000001100100', '0000001100101'];
// Erweiterte Make-up-Codes 1792..2560 (für beide Farben gleich)
const XM = ['00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100', '000000010101', '000000010110', '000000010111', '000000011100', '000000011101', '000000011110', '000000011111'];

const toCode = (s) => [parseInt(s, 2), s.length];
const W_TERM = WT.map(toCode), W_MAKE = WM.map(toCode), B_TERM = BT.map(toCode), B_MAKE = BM.map(toCode), X_MAKE = XM.map(toCode);

class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.acc = 0; this.n = 0; }
  write(code, len) {
    while (len > 0) {
      const take = Math.min(len, 8 - this.n);
      const bits = (code >>> (len - take)) & ((1 << take) - 1);
      this.acc = (this.acc << take) | bits;
      this.n += take; len -= take;
      if (this.n === 8) {
        if (this.pos >= this.buf.length) { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
        this.buf[this.pos++] = this.acc; this.acc = 0; this.n = 0;
      }
    }
  }
  finish() { if (this.n > 0) this.write(0, 8 - this.n); return this.buf.subarray(0, this.pos); }
}

function writeRun(bw, run, black) {
  const term = black ? B_TERM : W_TERM, make = black ? B_MAKE : W_MAKE;
  while (run >= 2560) { bw.write(...X_MAKE[12]); run -= 2560; }
  if (run >= 64) {
    const m = run - (run % 64);
    if (m >= 1792) bw.write(...X_MAKE[(m - 1792) / 64]);
    else bw.write(...make[m / 64 - 1]);
    run -= m;
  }
  bw.write(...term[run]);
}

// line: Uint8Array mit 1 = schwarz, 0 = weiß; Pixel links von 0 gilt als weiß
function nextChange(line, start, w) {
  let prev = start > 0 ? line[start - 1] : 0;
  for (let p = Math.max(0, start); p < w; p++) { if (line[p] !== prev) return p; }
  return w;
}

/** pixels(y) liefert eine Zeile (Uint8Array, 1 = schwarz) */
export function encodeG4(width, height, rowAt) {
  const bw = new BitWriter(Math.max(1024, (width * height) >> 5));
  let ref = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const cur = rowAt(y);
    let a0 = -1, color = 0;
    while (a0 < width) {
      let b1 = nextChange(ref, a0 + 1, width);
      while (b1 < width && ref[b1] === color) b1 = nextChange(ref, b1 + 1, width);
      const b2 = b1 < width ? nextChange(ref, b1 + 1, width) : width;
      const a1 = nextChange(cur, a0 + 1, width);
      if (b2 < a1) {
        bw.write(0b0001, 4); // Pass-Modus
        a0 = b2;
      } else {
        const d = a1 - b1;
        if (d >= -3 && d <= 3) {
          // Vertikal-Modus
          if (d === 0) bw.write(1, 1);
          else if (d === 1) bw.write(0b011, 3);
          else if (d === 2) bw.write(0b000011, 6);
          else if (d === 3) bw.write(0b0000011, 7);
          else if (d === -1) bw.write(0b010, 3);
          else if (d === -2) bw.write(0b000010, 6);
          else bw.write(0b0000010, 7);
          a0 = a1; color ^= 1;
        } else {
          // Horizontal-Modus
          const a2 = a1 < width ? nextChange(cur, a1 + 1, width) : width;
          bw.write(0b001, 3);
          writeRun(bw, a1 - Math.max(a0, 0), color === 1);
          writeRun(bw, a2 - a1, color === 0);
          a0 = a2;
        }
      }
    }
    ref = cur;
  }
  bw.write(0b000000000001, 12); bw.write(0b000000000001, 12); // EOFB
  return bw.finish();
}
