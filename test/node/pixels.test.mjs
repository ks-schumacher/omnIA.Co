// Pixel encoding: lossless whenever the values fit a 16-bit lattice, explicit refusal otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planEncoding, NotExactError } from '../../src/engine/pixels.js';

const vol = (dtype, data, slope = 0, inter = 0) => ({ dtype, data, header: { scl_slope: slope, scl_inter: inter } });
function assertExact(v, plan) {
  const { slope, inter } = plan;
  for (let i = 0; i < v.data.length; i++) {
    const s = v.header.scl_slope && Number.isFinite(v.header.scl_slope) ? v.header.scl_slope : 1;
    const b = v.header.scl_slope ? v.header.scl_inter : 0;
    const phys = v.data[i] * s + b;
    const stored = plan.store(i);
    assert.ok(Number.isInteger(stored), `stored value ${stored} is not an integer`);
    assert.ok(plan.signed ? stored >= -32768 && stored <= 32767 : stored >= 0 && stored <= 65535, 'stored value fits 16 bits');
    const back = stored * slope + inter;
    if (v.dtype === 'float32') assert.equal(Math.fround(back), Math.fround(phys), `voxel ${i}: ${back} vs ${phys}`);
    else assert.equal(back, phys, `voxel ${i}`);
  }
}

test('int16 is stored directly (signed)', () => {
  const v = vol('int16', Int16Array.from([-1024, 0, 3071, 32767, -32768]));
  const p = planEncoding(v);
  assert.equal(p.mode, 'direct'); assert.equal(p.signed, true); assertExact(v, p);
});

test('uint16 is stored directly (unsigned)', () => {
  const v = vol('uint16', Uint16Array.from([0, 1, 65535]));
  const p = planEncoding(v);
  assert.equal(p.mode, 'direct'); assert.equal(p.signed, false); assertExact(v, p);
});

test('int32 values on a coarse integer lattice are stored losslessly', () => {
  const v = vol('int32', Int32Array.from([-500000, 0, 100000, 2000000]));
  const p = planEncoding(v);
  assert.equal(p.mode, 'lattice'); assertExact(v, p);
});

test('int32 values needing more than 65536 levels are refused unless quantisation is allowed', () => {
  const data = Int32Array.from({ length: 70000 }, (_, i) => i * 3 + (i % 2));
  assert.throws(() => planEncoding(vol('int32', data)), NotExactError);
  const p = planEncoding(vol('int32', data), { allowQuantize: true });
  assert.equal(p.mode, 'quantized');
  let worst = 0;
  for (let i = 0; i < data.length; i++) worst = Math.max(worst, Math.abs(p.store(i) * p.slope + p.inter - data[i]));
  assert.ok(worst <= p.maxAbsError * (1 + 1e-12) + 1e-9, `measured ${worst} > reported ${p.maxAbsError}`);
  assert.ok(p.maxAbsError > 0);
});

test('float32 values on a 0.25 lattice are stored losslessly', () => {
  const v = vol('float32', Float32Array.from([-3.75, -1, 0, 0.25, 12.5, 100.75]));
  const p = planEncoding(v);
  assert.notEqual(p.mode, 'quantized'); assertExact(v, p);
});

test('integer-valued float32 (e.g. dcm2niix CT) is stored losslessly', () => {
  const v = vol('float32', Float32Array.from([-1024, -1000, 0, 40, 3071]));
  const p = planEncoding(v);
  assert.notEqual(p.mode, 'quantized'); assertExact(v, p);
});

test('scaled int16 (scl_slope/scl_inter) keeps the physical values', () => {
  const v = vol('int16', Int16Array.from([-100, 0, 7, 2000]), 0.5, -10);
  const p = planEncoding(v);
  assertExact(v, p);
});

test('arbitrary float32 values are refused without quantisation', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const data = Float32Array.from({ length: 5000 }, () => rnd() * 1000 - 500);
  assert.throws(() => planEncoding(vol('float32', data)), NotExactError);
  const p = planEncoding(vol('float32', data), { allowQuantize: true });
  let worst = 0;
  for (let i = 0; i < data.length; i++) worst = Math.max(worst, Math.abs(p.store(i) * p.slope + p.inter - data[i]));
  assert.ok(worst <= p.maxAbsError * (1 + 1e-9) + 1e-12);
  assert.ok(p.maxAbsError <= (1000 / 65535) * 0.51, 'error is at most about half a quantisation step');
});

test('NaN voxels are refused in lossless mode', () => {
  assert.throws(() => planEncoding(vol('float32', Float32Array.from([0, NaN, 1]))), NotExactError);
});

test('complex / RGB datatypes are refused', () => {
  assert.throws(() => planEncoding({ dtype: 'complex64', data: new Float32Array(4), header: {} }), NotExactError);
});
