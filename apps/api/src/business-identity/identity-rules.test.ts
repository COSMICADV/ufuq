import { describe, expect, it } from 'vitest';

import { contrastRatio, inspectLogo, svgProblem, thermalProblem } from './identity-rules.js';

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0, 0, 0, 0]);
}

const svg = (body: string): Buffer => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">${body}</svg>`);

describe('logo inspection', () => {
  it('reads PNG and JPEG sizes from the bytes', () => {
    expect(inspectLogo(png(512, 256))).toEqual({ type: 'png', width: 512, height: 256 });
    expect(inspectLogo(jpeg(800, 600))).toEqual({ type: 'jpeg', width: 800, height: 600 });
  });
  it('refuses huge or tiny images', () => {
    expect(inspectLogo(png(5000, 100))).toBe('too_large');
    expect(inspectLogo(png(32, 32))).toBe('too_small');
  });
  it('accepts a plain SVG and reads its viewBox', () => {
    expect(inspectLogo(svg('<circle cx="50" cy="50" r="40" fill="#1E7AFF"/>'))).toEqual({ type: 'svg', width: 200, height: 100 });
    expect(inspectLogo(svg('<use href="#a"/><g id="a"/>'))).toMatchObject({ type: 'svg' });
    expect(inspectLogo(svg(`<rect fill="url('#g')"/><rect style="fill:url(#g)"/>`))).toMatchObject({ type: 'svg' });
  });
  it('refuses an SVG that runs code or loads from elsewhere', () => {
    for (const body of [
      '<script>alert(1)</script>',
      '<rect onload="alert(1)"/>',
      '<a href="javascript:alert(1)"><rect/></a>',
      '<image href="https://evil.test/x.png"/>',
      '<foreignObject><div/></foreignObject>',
      '<style>@import url(https://evil.test/a.css)</style>',
      '<rect style="fill:url(https://evil.test/x)"/>',
      '<image xlink:href="data:text/html;base64,PHNjcmlwdD4="/>',
    ]) {
      expect(inspectLogo(svg(body)), body).toBe('unsafe_svg');
    }
    expect(svgProblem('<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>')).toBe('unsafe_svg');
  });
  it('refuses anything else', () => {
    expect(inspectLogo(Buffer.from('GIF89a....'))).toBe('unsupported_type');
    expect(inspectLogo(Buffer.from('<html><body>hi</body></html>'))).toBe('unsupported_type');
  });
  it('limits the thermal copy to 80 mm paper', () => {
    expect(thermalProblem(png(576, 200))).toBeNull();
    expect(thermalProblem(png(800, 200))).toBe('too_large');
    expect(thermalProblem(jpeg(300, 100))).toBe('unsupported_type');
  });
});

describe('contrast', () => {
  it('matches WCAG', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(contrastRatio('#1E7AFF', '#FFFFFF')).toBeGreaterThan(3.5);
    expect(contrastRatio('#FFFF00', '#FFFFFF')).toBeLessThan(1.2);
  });
});
