// Pure counting logic. No browser APIs: the same code is covered by Node tests.
export class LaneCounter {
  constructor(id) {
    this.id = id;
    this.count = 0;
    this.resetMotion();
    this.lastSeen = -Infinity;
  }

  resetMotion() {
    this.smoothedY = null;
    this.baselineY = null;
    this.state = 'ground';
    this.takeoffAt = 0;
    this.lastJumpAt = -Infinity;
    this.peakLift = 0;
    this.lastSampleAt = null;
    this.threshold = 0;
  }

  reset() {
    this.count = 0;
    this.resetMotion();
    this.lastSeen = -Infinity;
  }

  observe(y, torsoHeight, now, { amplitudeRatio = 0.1, minInterval = 0.22 } = {}) {
    if (![y, torsoHeight, now].every(Number.isFinite) || torsoHeight <= 0) return false;
    if (this.lastSampleAt !== null && (now <= this.lastSampleAt || now - this.lastSampleAt > 850)) {
      // Tracking interruption invalidates a half-jump, but never a recorded result.
      this.resetMotion();
    }
    this.lastSeen = now;
    this.lastSampleAt = now;
    this.threshold = Math.max(0.008, Math.min(0.055, torsoHeight * amplitudeRatio));
    this.smoothedY = this.smoothedY === null ? y : 0.65 * y + 0.35 * this.smoothedY;
    const currentY = this.smoothedY;

    if (this.baselineY === null) {
      this.baselineY = currentY;
      return false;
    }

    if (this.state === 'ground') {
      // Screen y grows downwards. Ground is the local *maximum* hip y.
      // Slow decay allows the baseline to follow small camera/person drift.
      this.baselineY = Math.max(currentY, this.baselineY - 0.0005);
      const lift = this.baselineY - currentY;
      if (lift >= this.threshold) {
        this.state = 'air';
        this.takeoffAt = now;
        this.peakLift = lift;
      }
      return false;
    }

    this.peakLift = Math.max(this.peakLift, this.baselineY - currentY);
    const elapsed = now - this.takeoffAt;
    if (elapsed > 700) {
      // Remaining elevated is not repeated jumping; re-calibrate cleanly.
      this.state = 'ground';
      this.baselineY = currentY;
      return false;
    }
    if (currentY >= this.baselineY - this.threshold * 0.42) {
      this.state = 'ground';
      this.baselineY = Math.max(currentY, this.baselineY - 0.001);
      if (elapsed >= 55 && this.peakLift >= this.threshold && now - this.lastJumpAt >= minInterval * 1000) {
        this.count += 1;
        this.lastJumpAt = now;
        return true;
      }
    }
    return false;
  }

  missing(now) {
    if (now - this.lastSeen > 850 && this.lastSampleAt !== null) this.resetMotion();
  }

  adjust(delta) {
    this.count = Math.max(0, this.count + delta);
  }
}

function visiblePoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    (point.visibility === undefined || point.visibility >= 0.35);
}

function averagePair(left, right) {
  if (visiblePoint(left) && visiblePoint(right)) {
    return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  }
  if (visiblePoint(left)) return { x: left.x, y: left.y };
  if (visiblePoint(right)) return { x: right.x, y: right.y };
  return null;
}

export function poseCenter(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 25) return null;
  const hip = averagePair(landmarks[23], landmarks[24]);
  const shoulder = averagePair(landmarks[11], landmarks[12]);
  if (!hip || !shoulder) return null;
  const torso = Math.abs(hip.y - shoulder.y);
  if (torso < 0.035 || torso > 0.5) return null;
  return { x: hip.x, y: hip.y, torso };
}

// Stable *positions* instead of fragile person IDs. Students must remain in lanes.
export function assignPosesToLanes(poseList, laneCount, toScreenX = x => x) {
  const assignments = new Map();
  for (const landmarks of poseList || []) {
    const center = poseCenter(landmarks);
    if (!center) continue;
    const screenX = toScreenX(center.x);
    if (screenX < 0 || screenX >= 1) continue;
    const lane = Math.floor(screenX * laneCount);
    const distance = Math.abs(screenX - (lane + 0.5) / laneCount);
    const previous = assignments.get(lane);
    if (!previous || distance < previous.distance) {
      assignments.set(lane, { ...center, landmarks, distance });
    }
  }
  return assignments;
}
