'use strict';
// Clip player: the original file from the card, drawn through a WebGL view transform so log footage
// can be watched as Rec.709. Views are monitoring approximations, not grades.

(function () {
  const LOOKS = [
    ['none', 'As shot (no transform)'],
    ['slog3', 'Sony S-Log3 / S-Gamut3.Cine → Rec.709'],
    ['clog3', 'Canon Log 3 → Rec.709'],
    ['vlog', 'Panasonic V-Log / V-Gamut → Rec.709'],
    ['logc3', 'ARRI LogC3 / AWG3 → Rec.709'],
    ['hlg', 'HLG / Rec.2020 → Rec.709'],
  ];
  const LOOK_ID = Object.fromEntries(LOOKS.map(([k], i) => [k, i]));

  const VERT = `#version 300 es
  in vec2 p; out vec2 uv;
  void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

  // Decode the log curve to scene linear, convert the camera gamut to Rec.709, tone map, encode for the display.
  const FRAG = `#version 300 es
  precision highp float;
  in vec2 uv; out vec4 o;
  uniform sampler2D tex; uniform int look; uniform float gain;
  vec3 m3(vec3 c, vec3 r0, vec3 r1, vec3 r2) { return vec3(dot(r0, c), dot(r1, c), dot(r2, c)); }
  float slog3(float x) { x *= 1023.0; return x >= 171.2102946929 ? pow(10.0, (x - 420.0) / 261.5) * 0.19 - 0.01 : (x - 95.0) * 0.01125 / (171.2102946929 - 95.0); }
  float clog3(float x) {
    if (x < 0.097465473) return -(pow(10.0, (0.12783901 - x) / 0.36726845) - 1.0) / 14.98325;
    if (x <= 0.15277891) return (x - 0.12512219) / 1.9754798;
    return (pow(10.0, (x - 0.12240537) / 0.36726845) - 1.0) / 14.98325;
  }
  float vlog(float x) { return x < 0.181 ? (x - 0.125) / 5.6 : pow(10.0, (x - 0.598206) / 0.241514) - 0.00873; }
  float logc3(float x) { return x > 0.149658 ? (pow(10.0, (x - 0.385537) / 0.247190) - 0.052272) / 5.555556 : (x - 0.092809) / 5.367655; }
  float hlg(float e) { return e <= 0.5 ? e * e / 3.0 : (exp((e - 0.55991073) / 0.17883277) + 0.28466892) / 12.0; }
  float srgb(float y) { return y <= 0.0031308 ? 12.92 * y : 1.055 * pow(y, 1.0 / 2.4) - 0.055; }
  void main() {
    vec3 c = texture(tex, uv).rgb;
    if (look == 0) { o = vec4(c, 1.0); return; }
    vec3 cv = (64.0 + c * 876.0) / 1023.0; // the decoder expanded legal range; log curves are defined on code values
    vec3 l;
    if (look == 1) l = m3(vec3(slog3(cv.r), slog3(cv.g), slog3(cv.b)), vec3(1.6269474, -0.5401385, -0.0868089), vec3(-0.1785155, 1.4179409, -0.2394254), vec3(-0.0444361, -0.1959199, 1.2403560));
    else if (look == 2) l = vec3(clog3(cv.r), clog3(cv.g), clog3(cv.b));
    else if (look == 3) l = m3(vec3(vlog(cv.r), vlog(cv.g), vlog(cv.b)), vec3(1.806576, -0.695697, -0.110879), vec3(-0.170090, 1.305955, -0.135865), vec3(-0.025206, -0.154468, 1.179674));
    else if (look == 4) l = m3(vec3(logc3(cv.r), logc3(cv.g), logc3(cv.b)), vec3(1.617523, -0.537287, -0.080237), vec3(-0.070573, 1.334613, -0.264040), vec3(-0.021102, -0.226954, 1.248056));
    else l = m3(vec3(hlg(c.r), hlg(c.g), hlg(c.b)) * 3.75, vec3(1.6605, -0.5876, -0.0728), vec3(-0.1246, 1.1329, -0.0083), vec3(-0.0182, -0.1006, 1.1187));
    l = max(l * gain * 1.2, 0.0);
    l = l * (1.0 + l / 16.0) / (1.0 + l); // soft highlight roll-off, white at 4.0
    o = vec4(srgb(l.r), srgb(l.g), srgb(l.b), 1.0);
  }`;

  function makeGl(canvas) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return { gl, look: gl.getUniformLocation(prog, 'look'), gain: gl.getUniformLocation(prog, 'gain') };
  }

  const fmt = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');

  // open({ h, fingerprint, file, onLook }) — `h` is the renderer's DOM builder.
  async function open({ h, fingerprint, file, onLook }) {
    const dlg = document.getElementById('dlg');
    const name = file.relative_path.split('/').pop();
    const external = () => window.harbor.openClipExternally(fingerprint, file.relative_path);
    const close = () => dlg.close();
    let res;
    try { res = await window.harbor.resolveClip(fingerprint, file.relative_path); } catch (e) { res = { error: e.message }; }

    if (res.error) {
      dlg.replaceChildren(h('h3', {}, name), h('p', {}, res.error), h('div', { class: 'actions' }, h('button', { onclick: close }, 'OK')));
      return dlg.showModal();
    }
    if (!res.mounted) return connectPanel(h, dlg, fingerprint, file, res, onLook);

    const video = h('video', { crossorigin: 'anonymous', preload: 'auto', playsinline: true });
    const canvas = h('canvas', { class: 'screen' });
    const status = h('div', { class: 'meta' });
    const scrub = h('input', { type: 'range', min: '0', max: '1000', value: '0', class: 'scrub' });
    const time = h('span', { class: 'time' }, '0:00 / 0:00');
    const playBtn = h('button', { class: 'play' }, '▶');
    const lookSel = h('select', {}, LOOKS.map(([k, label]) => h('option', { value: k, selected: k === res.look }, label)));
    const stage = h('div', { class: 'stage' }, canvas);
    let gl = null; let raf = 0; let dragging = false;

    try { gl = makeGl(canvas); } catch (e) { gl = null; }
    if (!gl) { stage.replaceChildren(video); lookSel.disabled = true; status.textContent = 'Log views need WebGL, which is unavailable; showing the clip as shot.'; }

    const draw = () => {
      if (gl && video.readyState >= 2) {
        const w = video.videoWidth; const hgt = video.videoHeight;
        const scale = Math.min(1, 1920 / w);
        if (canvas.width !== Math.round(w * scale)) { canvas.width = Math.round(w * scale); canvas.height = Math.round(hgt * scale); }
        const g = gl.gl;
        g.viewport(0, 0, canvas.width, canvas.height);
        try { g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, video); } catch (e) {
          gl = null; stage.replaceChildren(video); lookSel.disabled = true; status.textContent = 'Showing the clip as shot (this file cannot be filtered).'; return;
        }
        g.uniform1i(gl.look, LOOK_ID[lookSel.value] || 0); g.uniform1f(gl.gain, 1.0);
        g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
      }
      if (!dragging && video.duration) scrub.value = String(Math.round((video.currentTime / video.duration) * 1000));
      time.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
      playBtn.textContent = video.paused ? '▶' : '❚❚';
      raf = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
    };
    const redraw = () => { if (video.paused) requestAnimationFrame(() => { if (gl && video.readyState >= 2) { const g = gl.gl; g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, video); g.uniform1i(gl.look, LOOK_ID[lookSel.value] || 0); g.drawArrays(g.TRIANGLE_STRIP, 0, 4); } time.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`; playBtn.textContent = video.paused ? '▶' : '❚❚'; }); };
    const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());

    playBtn.addEventListener('click', toggle);
    canvas.addEventListener('click', toggle);
    scrub.addEventListener('input', () => { dragging = true; if (video.duration) video.currentTime = (scrub.value / 1000) * video.duration; });
    scrub.addEventListener('change', () => { dragging = false; });
    lookSel.addEventListener('change', () => { onLook(lookSel.value); redraw(); });
    video.addEventListener('loadeddata', () => { draw(); });
    video.addEventListener('seeked', redraw);
    video.addEventListener('pause', redraw);
    video.addEventListener('error', () => {
      stage.replaceChildren(h('div', { class: 'noplay' },
        h('p', {}, `Harbor can't decode this clip's format (${(name.split('.').pop() || '').toUpperCase()}).`),
        h('p', { class: 'meta' }, 'ProRes RAW, Blackmagic RAW, R3D, ARRIRAW and some 10-bit 4:2:2 files need a dedicated app.'),
        h('button', { onclick: external }, 'Open in default app')));
    });
    const keys = (e) => {
      if (e.target.tagName === 'SELECT') return;
      if (e.key === ' ') { e.preventDefault(); toggle(); }
      else if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration || 0, video.currentTime + (e.shiftKey ? 10 : 1));
      else if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 10 : 1));
    };
    dlg.addEventListener('keydown', keys);
    dlg.addEventListener('close', () => {
      dlg.removeEventListener('keydown', keys); dlg.classList.remove('player');
      if (video.cancelVideoFrameCallback && raf) video.cancelVideoFrameCallback(raf); else cancelAnimationFrame(raf);
      video.pause(); video.removeAttribute('src'); video.load();
    }, { once: true });

    dlg.classList.add('player');
    dlg.replaceChildren(
      h('div', { class: 'phead' }, h('h3', {}, name), h('div', { class: 'spacer' }), h('button', { class: 'ghost', onclick: external }, 'Open in default app'), h('button', { class: 'ghost', onclick: close }, 'Close')),
      stage,
      h('div', { class: 'controls' }, playBtn, scrub, time, h('label', { class: 'look' }, 'View ', lookSel)),
      status);
    if (!res.inside) status.textContent = 'This format may not play inside Harbor; if it stays black, use Open in default app.';
    video.src = res.url;
    dlg.showModal();
    video.play().catch(() => {});
  }

  function connectPanel(h, dlg, fingerprint, file, res, onLook) {
    const msg = h('p', { class: 'meta' });
    const retry = async (tries) => {
      const r = await window.harbor.resolveClip(fingerprint, file.relative_path).catch(() => null);
      if (r && r.mounted) { dlg.close(); return open({ h, fingerprint, file, onLook }); }
      if (tries > 0 && dlg.open) setTimeout(() => retry(tries - 1), 1500);
      else if (dlg.open) msg.textContent = 'Still not connected. If Finder asked for a login, use the same one as the Harbor share, or choose the folder yourself.';
    };
    dlg.replaceChildren(h('h3', {}, 'Connect the card to play clips'),
      h('p', {}, `The card is plugged into the NAS. To play its clips on this Mac, Harbor opens the card's network share${res.share ? ` (${res.share})` : ''} once. It is read the same way as any other share, and nothing on the card changes.`),
      msg,
      h('div', { class: 'actions' },
        h('button', { class: 'ghost', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'ghost', onclick: async () => { if (await window.harbor.pickCardFolder(fingerprint)) retry(0); else msg.textContent = "That folder doesn't hold this card's files."; } }, 'Choose folder…'),
        h('button', { onclick: async () => { msg.textContent = 'Connecting…'; if (await window.harbor.connectCard(fingerprint)) retry(12); else msg.textContent = "Couldn't find the NAS address. Use Choose folder… instead."; } }, res.share ? `Connect ${res.share}` : 'Connect')));
    dlg.showModal();
  }

  window.HarborPlayer = { open, LOOKS };
}());
