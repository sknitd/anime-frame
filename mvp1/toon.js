// WebGL2 cartoon pipeline:
//   1. edge-preserving bilateral smoothing (flattens skin, keeps contours)
//   2. XDoG outlines computed on the *smoothed* image, so noise and pores never become ink
//   3. soft cel shading + bright, saturated grade
//   4. optional person mask -> softly blurred background, like an anime backdrop
// Output is mirrored (selfie view).

const VS = `#version 300 es
layout(location=0) in vec2 p; out vec2 uv;
void main(){ uv = p*.5+.5; gl_Position = vec4(p,0.,1.); }`;

const HEAD = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
float lum(vec3 c){ return dot(c, vec3(.299,.587,.114)); }
uniform sampler2D m; // person mask: uploaded top-down and unmirrored
float person(vec2 p){
  vec2 q = 1. - p, o = 3. / vec2(textureSize(m, 0));   // small blur hides the mask's low-res staircase
  float v = texture(m, q).r*.4 + (texture(m, q + o).r + texture(m, q - o).r
          + texture(m, q + vec2(o.x, -o.y)).r + texture(m, q + vec2(-o.x, o.y)).r)*.15;
  return smoothstep(.25, .75, v);
}
`;

const FS = {
  // source -> working texture, mirrored like a selfie camera
  copy: `uniform sampler2D t; uniform float gain;
    void main(){
      vec3 c = texture(t, vec2(1.-uv.x, uv.y)).rgb;
      o = vec4(c*gain/(1. + (gain - 1.)*c), 1.);         // auto exposure with a soft shoulder (never clips)
    }`,

  // one separable bilateral pass (run H then V, iterated)
  bilateral: `uniform sampler2D t; uniform vec2 dir; uniform float sigR;
    void main(){
      vec3 c0 = texture(t, uv).rgb; vec3 s = c0; float ws = 1.;
      float k = -.5/(sigR*sigR);
      for (int i = 1; i <= 6; i++){
        float fi = float(i), wd = exp(-fi*fi/18.);
        vec3 a = texture(t, uv + dir*fi).rgb, b = texture(t, uv - dir*fi).rgb;
        vec3 da = a - c0, db = b - c0;
        float wa = wd*exp(k*dot(da,da)), wb = wd*exp(k*dot(db,db));
        s += a*wa + b*wb; ws += wa + wb;
      }
      o = vec4(s/ws, 1.);
    }`,

  // XDoG, horizontal: two gaussians of luminance
  dogH: `uniform sampler2D t; uniform vec2 dir; uniform float sig;
    void main(){
      float s1 = sig, s2 = sig*1.6, l0 = lum(texture(t, uv).rgb);
      float g1 = l0, g2 = l0, w1 = 1., w2 = 1.;
      for (int i = 1; i <= 8; i++){
        float fi = float(i);
        float l = lum(texture(t, uv + dir*fi).rgb) + lum(texture(t, uv - dir*fi).rgb);
        float a = exp(-fi*fi/(2.*s1*s1)), b = exp(-fi*fi/(2.*s2*s2));
        g1 += l*a; w1 += 2.*a; g2 += l*b; w2 += 2.*b;
      }
      o = vec4(g1/w1, g2/w2, 0., 1.);
    }`,

  // XDoG, vertical + soft threshold -> 1 = paper, 0 = ink
  dogV: `uniform sampler2D t; uniform vec2 dir; uniform float sig, tau, eps, phi;
    void main(){
      float s1 = sig, s2 = sig*1.6; vec2 c = texture(t, uv).rg;
      float g1 = c.r, g2 = c.g, w1 = 1., w2 = 1.;
      for (int i = 1; i <= 8; i++){
        float fi = float(i);
        vec2 v = texture(t, uv + dir*fi).rg + texture(t, uv - dir*fi).rg;
        float a = exp(-fi*fi/(2.*s1*s1)), b = exp(-fi*fi/(2.*s2*s2));
        g1 += v.r*a; w1 += 2.*a; g2 += v.g*b; w2 += 2.*b;
      }
      float D = g1/w1 - tau*(g2/w2);
      float e = D >= eps ? 1. : 1. + tanh(phi*(D - eps));
      o = vec4(e, 0., 0., 1.);
    }`,

  // background-only gaussian (person pixels excluded, so no halo)
  blur: `uniform sampler2D t; uniform vec2 dir; uniform float sig, first;
    vec4 S(vec2 p){
      if (first > .5){ float b = 1. - person(p); return vec4(texture(t, p).rgb*b, b); }
      return texture(t, p);
    }
    void main(){
      vec4 s = S(uv); float ws = 1.;
      for (int i = 1; i <= 10; i++){
        float fi = float(i), w = exp(-fi*fi/(2.*sig*sig));
        s += (S(uv + dir*fi) + S(uv - dir*fi))*w; ws += 2.*w;
      }
      o = s/ws;
    }`,

  composite: `uniform sampler2D tA, tE, tF;
    uniform float lineA, bgLine, sat, gam, qMix, qN, qPhi, bgAmt, contrast, sharp, haze;
    uniform vec2 px;
    uniform vec3 ink;
    vec3 toYCC(vec3 c){ float y = lum(c); return vec3(y, (c.b-y)*.564, (c.r-y)*.713); }
    vec3 toRGB(vec3 v){ float r = v.x + 1.403*v.z, b = v.x + 1.773*v.y; return vec3(r, (v.x - .299*r - .114*b)/.587, b); }
    void main(){
      vec3 a = texture(tA, uv).rgb;
      vec2 dx = vec2(px.x*1.5, 0.), dy = vec2(0., px.y*1.5);
      vec3 nb = (texture(tA, uv+dx).rgb + texture(tA, uv-dx).rgb + texture(tA, uv+dy).rgb + texture(tA, uv-dy).rgb)*.25;
      a += sharp*(a - nb);                               // crisp features (the smoothing already removed noise)
      float pm = person(uv);
      vec4 f = texture(tF, uv);
      vec3 bg = f.a > .02 ? f.rgb/f.a : a;
      bg = mix(bg, vec3(1.), haze);                      // airy backdrop
      vec3 col = mix(a, bg, (1. - pm)*bgAmt);

      vec3 y = toYCC(col);
      float qn = floor(y.x*qN + .5)/qN;                  // soft cel shading (tanh ramps, no hard bands)
      y.x = mix(y.x, qn + (.5/qN)*tanh(qPhi*(y.x - qn)), qMix);
      y.x = pow(clamp(y.x, 0., 1.), gam);                // brighter, lifted shadows
      y.x = mix(y.x, y.x*y.x*(3. - 2.*y.x), contrast);   // midtone punch
      y.yz *= 1. + (sat - 1.)*(1. - smoothstep(.06, .22, length(y.yz))); // vibrance: dull colours pop, skin doesn't go orange
      col = toRGB(y)*vec3(1.015, 1., .985);              // a touch warm

      // ink, minus isolated dots: a pixel keeps its ink only if its 3x3 neighbourhood forms a line
      float k = 1. - texture(tE, uv).r, k9 = 0.;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) k9 += 1. - texture(tE, uv + vec2(i, j)*px).r;
      k *= smoothstep(1.3, 3.0, k9);
      col = mix(col, ink, k*lineA*mix(bgLine, 1., pm));
      o = vec4(clamp(col, 0., 1.), 1.);
    }`,
};

export function createToon(canvas) {
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
  if (!gl) return null;
  const floatOK = !!gl.getExtension('EXT_color_buffer_float');

  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const vs = sh(gl.VERTEX_SHADER, VS);
  const progs = {};
  for (const [name, body] of Object.entries(FS)) {
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, HEAD + body)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(name + ': ' + gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name);
    }
    progs[name] = { p, u };
  }
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function newTex() {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target(w, h) {
    const t = newTex();
    if (floatOK) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, fb, w, h };
  }

  const texSrc = newTex();
  const texMask = newTex();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255])); // all "person"
  let hasMask = false, T = null, srcW = 0, srcH = 0, W = 0, H = 0;

  function alloc(sw, sh) {
    srcW = sw; srcH = sh;
    W = Math.min(1280, sw); H = Math.round(sh * W / sw);   // processing resolution
    canvas.width = W; canvas.height = H;
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
    T = { A: target(W, H), B: target(W, H), C: target(W, H), D: target(W, H), E: target(W, H),
          G: target(hw, hh), F: target(hw, hh) };
  }

  function run(name, dst, tex, uni = {}) {
    const { p, u } = progs[name];
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
    gl.viewport(0, 0, dst ? dst.w : W, dst ? dst.h : H);
    let unit = 0;
    for (const [k, t] of Object.entries({ m: texMask, ...tex })) {
      if (!u[k]) continue;
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t.t || t); gl.uniform1i(u[k], unit++);
    }
    for (const [k, v] of Object.entries(uni)) {
      if (!u[k]) continue;
      if (Array.isArray(v)) gl['uniform' + v.length + 'fv'](u[k], v); else gl.uniform1f(u[k], v);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Auto exposure: centre-weighted brightness (where the face usually is) -> gain toward mid-grey.
  const meterCv = document.createElement('canvas'); meterCv.width = 48; meterCv.height = 27;
  const mctx = meterCv.getContext('2d', { willReadFrequently: true });
  let gain = 0, frames = 0;
  function meter(source) {
    mctx.drawImage(source, 0, 0, 48, 27);
    const d = mctx.getImageData(0, 0, 48, 27).data;
    let s = 0, ws = 0;
    for (let y = 0; y < 27; y++) for (let x = 0; x < 48; x++) {
      const dx = (x + .5) / 48 - .5, dy = (y + .5) / 27 - .45, w = Math.exp(-(dx * dx + dy * dy) / 0.1);
      const i = (y * 48 + x) * 4;
      s += w * (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255; ws += w;
    }
    const m = Math.min(Math.max(s / ws, 0.02), 0.98), t = 0.5;
    const g = Math.min(Math.max(t * (1 - m) / (m * (1 - t)), 1), 2.6);  // gain that maps m -> t on the shoulder curve
    gain = gain ? gain * 0.8 + g * 0.2 : g;
  }

  // u8: person confidence 0..255, row 0 = top of the (unmirrored) source
  function setMask(u8, w, h) {
    gl.bindTexture(gl.TEXTURE_2D, texMask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, u8);
    hasMask = true;
  }

  // Slider values (0..1) -> filter settings. P.override can pin any of these directly.
  function settings(P) {
    return {
      sigR: 0.04 + 0.08 * P.smooth,            // colour tolerance of the smoothing
      step: 0.7 + 0.8 * P.smooth,              // smoothing reach (px at 1280 wide)
      it1: 1, it2: 2,                          // smoothing passes before / after edge detection
      dogSig: 1.0, tau: 0.98, eps: -(0.008 - 0.007 * P.lines), phi: 100,
      lineA: 0.3 + 0.65 * P.lines, bgLine: 0.08,
      sat: 1 + 0.9 * P.pop, gam: 1 - 0.1 * P.pop, contrast: P.pop, sharp: 0.3 + 0.6 * P.pop, haze: 0.03,
      qMix: 0.25, qN: 8, qPhi: 35,
      bgSig: 1 + 4 * P.bg,
      exposure: 0,                             // 0 = automatic
      ...(P.override || {}),
    };
  }

  // P: { smooth, lines, pop, bg } each 0..1
  function render(source, P) {
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return false;
    if (sw !== srcW || sh !== srcH) alloc(sw, sh);

    gl.bindTexture(gl.TEXTURE_2D, texSrc);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    const s = settings(P);
    const sc = W / 1280, px = [1 / W, 1 / H];
    const Hd = [px[0] * s.step * sc, 0], Vd = [0, px[1] * s.step * sc];
    const { A, B, C, D, E, F, G } = T;

    // bilateral iterations ping-pong between A and C (B holds the horizontal half)
    let cur = A;
    const smoothOnce = () => {
      const dst = cur === A ? C : A;
      run('bilateral', B, { t: cur }, { dir: Hd, sigR });
      run('bilateral', dst, { t: B }, { dir: Vd, sigR });
      cur = dst;
    };

    if (frames++ % 3 === 0) meter(source);
    const g = s.exposure || gain;
    run('copy', A, { t: texSrc }, { gain: g });
    // brightening a dark frame amplifies sensor noise too: smooth harder and demand stronger edges
    const sigR = s.sigR * (1 + 0.6 * (g - 1)), eps = s.eps * (1 + 1.2 * (g - 1));
    for (let i = 0; i < s.it1; i++) smoothOnce();

    const dog = { sig: s.dogSig * Math.max(sc, 0.75), tau: s.tau, eps, phi: s.phi };
    run('dogH', D, { t: cur }, { dir: [px[0], 0], ...dog });
    run('dogV', E, { t: D }, { dir: [0, px[1]], ...dog });

    for (let i = 0; i < s.it2; i++) smoothOnce();

    const bgAmt = hasMask && P.bg > 0.01 ? 1 : 0;
    if (bgAmt) {
      const hs = 1.5 * sc;
      run('blur', G, { t: cur }, { dir: [hs / G.w, 0], sig: s.bgSig, first: 1 });
      run('blur', F, { t: G }, { dir: [0, hs / G.h], sig: s.bgSig, first: 0 });
    }
    run('composite', null, { tA: cur, tE: E, tF: F }, {
      lineA: s.lineA, bgLine: s.bgLine, ink: [0.11, 0.07, 0.07], px,
      sat: s.sat, gam: s.gam, contrast: s.contrast, sharp: s.sharp, haze: s.haze,
      qMix: s.qMix, qN: s.qN, qPhi: s.qPhi, bgAmt,
    });
    return true;
  }

  return { render, setMask, get gain() { return gain; } };
}
