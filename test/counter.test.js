import test from 'node:test';
import assert from 'node:assert/strict';
import { LaneCounter, poseCenter, assignPosesToLanes } from '../counter.js';

function syntheticJump(counter, start, cycles, period = 300, interval = 40) {
  for (let t = 0; t <= cycles * period; t += interval) {
    const phase = (t % period) / period;
    const lift = 0.045 * Math.max(0, Math.sin(Math.PI * phase));
    counter.observe(0.62 - lift, 0.2, start + t);
  }
}

test('recognises repeated complete takeoff/landing cycles at ~200 jumps/min', () => {
  const lane = new LaneCounter(1);
  syntheticJump(lane, 1000, 10, 300, 30);
  assert.ok(lane.count >= 9 && lane.count <= 10, `count=${lane.count}`);
});

test('static and low-noise observations do not count', () => {
  const lane = new LaneCounter(1);
  for (let t = 0; t < 5000; t += 40) lane.observe(0.62 + Math.sin(t / 130) * 0.002, 0.2, t);
  assert.equal(lane.count, 0);
});

test('lost detection preserves count and clears partial airborne state', () => {
  const lane = new LaneCounter(2);
  syntheticJump(lane, 1000, 3, 300, 30);
  const before = lane.count;
  lane.observe(0.58, 0.2, 1970);
  lane.missing(3500);
  assert.equal(lane.count, before);
  assert.equal(lane.state, 'ground');
  lane.observe(0.62, 0.2, 3600);
  assert.equal(lane.count, before);
});

test('manual correction never produces a negative count', () => {
  const lane = new LaneCounter(1);
  lane.adjust(3);
  lane.adjust(-7);
  assert.equal(lane.count, 0);
});

function pose(x, y = 0.62) {
  const lm = Array.from({ length: 33 }, () => ({ x, y, visibility: 0 }));
  lm[11] = { x: x - 0.01, y: y - 0.2, visibility: 0.9 };
  lm[12] = { x: x + 0.01, y: y - 0.2, visibility: 0.9 };
  lm[23] = { x: x - 0.01, y, visibility: 0.9 };
  lm[24] = { x: x + 0.01, y, visibility: 0.9 };
  return lm;
}

test('ten independent lanes keep position IDs when detections are shuffled', () => {
  const poses = Array.from({ length: 10 }, (_, i) => pose((i + 0.5) / 10));
  const lanes = assignPosesToLanes([...poses].reverse(), 10);
  assert.equal(lanes.size, 10);
  for (let i = 0; i < 10; i++) assert.ok(Math.abs(lanes.get(i).x - (i + 0.5) / 10) < 1e-8);
});

test('ignores detections without visible torso landmarks', () => {
  const lowQuality = pose(0.5);
  lowQuality[23].visibility = 0;
  lowQuality[24].visibility = 0;
  assert.equal(poseCenter(lowQuality), null);
  assert.equal(assignPosesToLanes([lowQuality], 10).size, 0);
});
