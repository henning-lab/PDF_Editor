// Bildformate, die Browser nicht selbst anzeigen können (HEIC/HEIF, TIFF), in JPEG umwandeln.
const ext = (n) => (/\.([^.]+)$/.exec(n || '') || [])[1]?.toLowerCase() || '';

async function canvasToJpeg(canvas) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function heicToJpeg(file) {
  const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
  const e = ext(file.name);
  const isTiff = (data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a) || (data[0] === 0x4d && data[1] === 0x4d && data[3] === 0x2a) || e === 'tif' || e === 'tiff';
  if (isTiff) {
    const UTIF = (await import('utif')).default || (await import('utif'));
    const ifds = UTIF.decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (!ifds.length) throw new Error('TIFF enthält kein Bild');
    UTIF.decodeImage(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const c = document.createElement('canvas');
    c.width = ifds[0].width; c.height = ifds[0].height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    const tmp = document.createElement('canvas'); tmp.width = c.width; tmp.height = c.height;
    tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), c.width, c.height), 0, 0);
    ctx.drawImage(tmp, 0, 0);
    return canvasToJpeg(c);
  }
  // Safari kann HEIC selbst dekodieren
  try {
    const bmp = await createImageBitmap(new Blob([data], { type: 'image/heic' }));
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    return canvasToJpeg(c);
  } catch (_) { /* weiter mit libheif */ }
  const heic2any = (await import('heic2any')).default;
  let blob = await heic2any({ blob: new Blob([data]), toType: 'image/jpeg', quality: 0.92 });
  if (Array.isArray(blob)) blob = blob[0];
  return new Uint8Array(await blob.arrayBuffer());
}
