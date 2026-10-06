// Turns two hands making "L"s (MediaPipe hand landmarks) into the frame quad, in display pixels
// (mirrored for a selfie camera, as recorded for a video file). Works with the L's upright, upside down, or one of each.

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y }), add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const cross = (a, b) => a.x * b.y - a.y * b.x, dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y), unit = (a) => mul(a, 1 / (len(a) || 1));
function intersect(p, d, q, e) {
  const den = cross(d, e); if (Math.abs(den) < 1e-6) return null;
  return add(p, mul(d, cross(sub(q, p), e) / den));
}
function convex(q) {
  const s = q.map((p, i) => Math.sign(cross(sub(q[(i + 1) % 4], p), sub(q[(i + 2) % 4], q[(i + 1) % 4]))));
  return s.every(v => v !== 0 && v === s[0]);
}

// landmarks: 2 thumb MCP, 3 thumb IP, 4 thumb tip, 5 index MCP, 8 index tip
function handL(lms, W, H, mirror) {
  const pt = (lm) => ({ x: (mirror ? 1 - lm.x : lm.x) * W, y: lm.y * H });
  const [t2, t3, t4, i5, tip] = [2, 3, 4, 5, 8].map(i => pt(lms[i]));
  // the L's vertex: where the index-finger line meets the thumb line (falls back to the knuckle midpoint)
  const mid = mul(add(t2, i5), .5), v = intersect(i5, sub(tip, i5), t3, sub(t4, t3));
  const corner = v && len(sub(v, mid)) < len(sub(tip, i5)) ? v : mid;
  return { corner, tip, index: sub(tip, corner), thumb: sub(t4, corner) };
}

export function createFrameTracker() {
  let smooth = null, mode = '';

  // hands: array of 21-landmark arrays; mirror: display is flipped (selfie camera). Returns 4 corners or null.
  function update(hands, W, H, mirror = true) {
    if (hands.length < 2) return null;
    // MediaPipe's hand order can flip between frames; keep the left-most hand first
    const [A, B] = [handL(hands[0], W, H, mirror), handL(hands[1], W, H, mirror)].sort((a, b) => a.corner.x - b.corner.x);
    const span = len(sub(A.corner, B.corner)), mid = mul(add(A.corner, B.corner), .5);
    if (span < 60) return null;
    let q, m;
    if (dot(unit(A.index), unit(B.index)) > 0.3) {
      // both L's the same way (both up, or both down): sides run along the index fingers. A finger pointing at
      // the camera looks short, which would pinch the frame into a wedge, so both sides take the longer finger's
      // length, and a very short finger borrows the other hand's direction.
      const la = len(A.index), lb = len(B.index), L = Math.max(la, lb);
      const dA = unit(la < L * 0.5 ? B.index : A.index), dB = unit(lb < L * 0.5 ? A.index : B.index);
      q = [A.corner, add(A.corner, mul(dA, L)), add(B.corner, mul(dB, L)), B.corner]; m = 'parallel';
    } else {
      // director's frame (one hand flipped): the other two corners are where one hand's index line meets the other's thumb line
      q = [A.corner, intersect(A.corner, A.index, B.corner, B.thumb), B.corner, intersect(B.corner, B.index, A.corner, A.thumb)]; m = 'director';
    }
    if (q.some(p => !p || len(sub(p, mid)) > span * 1.5) || !convex(q)) {
      // odd pose: fall back to the box around both hands' corners and fingertips
      const ps = [A.corner, A.tip, B.corner, B.tip], xs = ps.map(p => p.x), ys = ps.map(p => p.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      q = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]; m = 'box';
    }
    if (m !== mode) { smooth = null; mode = m; }   // corner order differs per mode; never blend across it
    smooth = smooth ? smooth.map((s, i) => add(mul(s, .55), mul(q[i], .45))) : q;
    return smooth;
  }

  return { update, reset: () => { smooth = null; mode = ''; }, get mode() { return mode; } };
}
