/* ═══════════════════════════════════════════════════════════════════
   EARTH · Digital Twin
   ───────────────────────────────────────────────────────────────────
   A fully client-side interactive 3D Earth:
   • photoreal globe with a live day/night terminator + city lights
   • toggleable cloud cover, flight traffic, borders, auto-rotation
   • hover any country/city → outline highlight + stats popup
   • zoom seamlessly from orbit down to street level (OSM/CARTO tiles)

   Everything except the street-map tiles is served from this repo,
   so the page has zero third-party JS/CDN dependencies.
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  /* ── Config ──────────────────────────────────────────────────── */
  const R = 100;                        // globe radius (world units)
  const EARTH_M_PER_UNIT = 6371000 / R; // meters per world unit
  const FOV = 45;
  const MIN_DIST = R * 1.045;           // ≈ 290 km altitude — map handoff height
  const MAX_DIST = R * 6.5;
  const DEG = Math.PI / 180;

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ── Shared state ────────────────────────────────────────────── */
  const state = {
    lightMode: 'auto',        // 'day' | 'night' | 'auto'
    clouds: true, flights: true, borders: true, spin: true,
    mapMode: false,
    ready: false,
  };

  /* ── Coordinate helpers (aligned with equirect textures) ─────── */
  function llToV3(lat, lng, r, out) {
    const phi = (90 - lat) * DEG;
    const theta = (lng + 180) * DEG;
    out = out || new THREE.Vector3();
    return out.set(
      -r * Math.sin(phi) * Math.cos(theta),
       r * Math.cos(phi),
       r * Math.sin(phi) * Math.sin(theta)
    );
  }
  function v3ToLL(v) {
    const r = v.length();
    const lat = 90 - Math.acos(clamp(v.y / r, -1, 1)) / DEG;
    let lng = Math.atan2(v.z, -v.x) / DEG - 180;
    if (lng < -180) lng += 360;
    if (lng > 180) lng -= 360;
    return { lat, lng };
  }

  /* ── Formatting helpers ──────────────────────────────────────── */
  const fmtArea = (a) => a == null ? '—' : Math.round(a).toLocaleString('en-US') + ' km²';
  const fmtPop = (m) => m == null ? '—'
    : m >= 1000 ? (m / 1000).toFixed(2) + ' B'
    : m >= 10 ? Math.round(m) + ' M'
    : m >= 1 ? m.toFixed(1) + ' M'
    : Math.round(m * 1000).toLocaleString('en-US') + ' K';
  const fmtGdp = (b) => b == null ? '—'
    : b >= 1000 ? '$' + (b / 1000).toFixed(2) + ' T'
    : b >= 10 ? '$' + Math.round(b) + ' B'
    : '$' + b.toFixed(1) + ' B';
  const fmtGdpPc = (gdpB, popM) => (gdpB == null || !popM) ? '—'
    : '$' + Math.round(gdpB / popM * 1000).toLocaleString('en-US');
  const flagEmoji = (a2) => !a2 ? '🏳️'
    : String.fromCodePoint(...[...a2.toUpperCase()].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65));

  /* ── Loading screen ──────────────────────────────────────────── */
  const loadState = { done: 0, total: 5 };
  function tickLoad(msg) {
    loadState.done++;
    $('#load-fill').style.width = Math.round(loadState.done / loadState.total * 100) + '%';
    if (msg) $('#load-msg').textContent = msg;
  }
  function fatal(msg) {
    const el = $('#loading');
    el.classList.add('error');
    el.classList.remove('done');
    $('#load-msg').innerHTML = msg;
  }

  /* ── Renderer / scene bootstrap ──────────────────────────────── */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    fatal('WebGL is not available in this browser.');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight);
  $('#globe').appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.1, 12000);

  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = MIN_DIST;
  controls.maxDistance = MAX_DIST;
  controls.minPolarAngle = 0.05;
  controls.maxPolarAngle = Math.PI - 0.05;
  controls.autoRotate = true;
  const AUTOROT_BASE = 0.35; // deg-equivalent at 60 fps; rescaled per-frame below

  /* ── Sun ─────────────────────────────────────────────────────── */
  const sunDir = new THREE.Vector3(1, 0, 0);      // current (smoothed)
  const sunTarget = new THREE.Vector3(1, 0, 0);   // where it should be
  function realSunDir(out) {
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), 0, 0);
    const doy = (now.getTime() - start) / 86400000;
    const declDeg = -23.44 * Math.cos(2 * Math.PI * (doy + 10) / 365.24);
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const lngDeg = (12 - utcH) * 15;
    return llToV3(declDeg, lngDeg, 1, out).normalize();
  }
  function updateSunTarget() {
    if (state.lightMode === 'day') sunTarget.copy(camera.position).normalize();
    else if (state.lightMode === 'night') sunTarget.copy(camera.position).normalize().negate();
    else realSunDir(sunTarget);
  }

  /* ── Lights (only shaded objects are the clouds) ─────────────── */
  const sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x334466, 0.22));

  /* ── Starfield ───────────────────────────────────────────────── */
  const stars = (() => {
    const N = 5500, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(3200 + Math.random() * 2400);
      pos.set([v.x, v.y, v.z], i * 3);
      const t = Math.random();
      const c = t < 0.82 ? [1, 1, 1] : t < 0.93 ? [0.72, 0.85, 1] : [1, 0.88, 0.7];
      const b = 0.45 + Math.random() * 0.55;
      col.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true,
      transparent: true, opacity: 0.95, depthWrite: false });
    const p = new THREE.Points(g, m);
    scene.add(p);
    return p;
  })();

  /* ── Textures ────────────────────────────────────────────────── */
  const texLoader = new THREE.TextureLoader();
  const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blackTex.needsUpdate = true;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  function loadTex(url, onDone) {
    texLoader.load(url,
      (t) => { t.anisotropy = Math.min(8, maxAniso); onDone(t); tickLoad(); },
      undefined,
      () => { tickLoad(); console.warn('texture failed:', url); });
  }

  /* ── Earth (custom day/night shader) ─────────────────────────── */
  const earthUniforms = {
    dayMap: { value: blackTex },
    nightMap: { value: blackTex },
    waterMap: { value: blackTex },
    sunDir: { value: sunDir },
    nightBoost: { value: 1.0 },
  };
  const earthMat = new THREE.ShaderMaterial({
    uniforms: earthUniforms,
    vertexShader: `
      varying vec2 vUv; varying vec3 vNormal; varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D dayMap, nightMap, waterMap;
      uniform vec3 sunDir; uniform float nightBoost;
      varying vec2 vUv; varying vec3 vNormal; varying vec3 vWorldPos;
      void main() {
        vec3 day = texture2D(dayMap, vUv).rgb;
        vec3 night = texture2D(nightMap, vUv).rgb;
        float water = texture2D(waterMap, vUv).r;
        vec3 n = normalize(vNormal);
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float cosA = dot(n, sunDir);
        float dayness = smoothstep(-0.14, 0.22, cosA);

        // day ground + faint blue ambient on the night side
        vec3 col = day * (0.035 + 0.965 * dayness);
        // city lights, fading out into daylight
        col += night * pow(1.0 - dayness, 1.5) * 1.35 * nightBoost;
        // warm terminator band
        float band = exp(-pow(cosA * 5.5, 2.0));
        col += vec3(0.95, 0.38, 0.12) * band * 0.16;
        // sun glint on water
        float spec = pow(max(dot(reflect(-sunDir, n), viewDir), 0.0), 42.0);
        col += vec3(0.9, 0.88, 0.75) * spec * water * dayness * 0.6;
        // faint atmospheric haze right at the limb (no detached glow ring)
        float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);
        col += vec3(0.22, 0.48, 1.0) * fres * (0.08 + 0.25 * dayness);

        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 96), earthMat);
  scene.add(earth);

  /* ── Clouds ──────────────────────────────────────────────────── */
  const cloudMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false,
  });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.012, 96, 72), cloudMat);
  clouds.visible = false; // enabled once its texture arrives
  scene.add(clouds);

  loadTex('assets/textures/earth-day.jpg', (t) => { earthUniforms.dayMap.value = t; });
  loadTex('assets/textures/earth-night.jpg', (t) => { earthUniforms.nightMap.value = t; });
  loadTex('assets/textures/earth-water.png', (t) => { earthUniforms.waterMap.value = t; });
  loadTex('assets/textures/earth-clouds.jpg', (t) => {
    cloudMat.alphaMap = t;
    cloudMat.needsUpdate = true;
    clouds.visible = state.clouds;
  });

  /* ── Countries: borders, hover index, highlight ──────────────── */
  const countries = [];       // {props, rings:[{pts:Float64Array lnglat, bbox}], segStart, segCount}
  let borderLines = null;     // all borders (one LineSegments)
  let hlLines = null;         // highlighted country (shares the position buffer)
  let hoveredCountry = null;

  function buildCountries(geojson) {
    const segPts = [];  // flat xyz pairs
    const rB = R * 1.0022;

    for (const f of geojson.features) {
      const entry = { props: f.properties, rings: [], segStart: segPts.length / 6, segCount: 0 };
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        for (const ring of poly) {
          // hover index (lng/lat + bbox)
          let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
          const flat = new Float64Array(ring.length * 2);
          for (let i = 0; i < ring.length; i++) {
            const x = ring[i][0], y = ring[i][1];
            flat[i * 2] = x; flat[i * 2 + 1] = y;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
          entry.rings.push({ pts: flat, bbox: [minX, minY, maxX, maxY] });
          // border line segments
          const a = new THREE.Vector3(), b = new THREE.Vector3();
          for (let i = 0; i < ring.length - 1; i++) {
            llToV3(ring[i][1], ring[i][0], rB, a);
            llToV3(ring[i + 1][1], ring[i + 1][0], rB, b);
            segPts.push(a.x, a.y, a.z, b.x, b.y, b.z);
          }
        }
      }
      entry.segCount = segPts.length / 6 - entry.segStart;
      countries.push(entry);
    }

    const posAttr = new THREE.BufferAttribute(new Float32Array(segPts), 3);
    const gAll = new THREE.BufferGeometry();
    gAll.setAttribute('position', posAttr);
    borderLines = new THREE.LineSegments(gAll, new THREE.LineBasicMaterial({
      color: 0x7fb4ff, transparent: true, opacity: 0.22, depthWrite: false,
    }));
    scene.add(borderLines);

    const gHl = new THREE.BufferGeometry();
    gHl.setAttribute('position', posAttr); // shared buffer — zero copy
    gHl.setDrawRange(0, 0);
    hlLines = new THREE.LineSegments(gHl, new THREE.LineBasicMaterial({
      color: 0x53e6ff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    hlLines.scale.setScalar(1.0006); // sit just above the base borders
    scene.add(hlLines);
  }

  function pointInRing(lng, lat, pts) {
    let inside = false;
    for (let i = 0, j = pts.length / 2 - 1; i < pts.length / 2; j = i++) {
      const xi = pts[i * 2], yi = pts[i * 2 + 1];
      const xj = pts[j * 2], yj = pts[j * 2 + 1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }
  function countryAt(lat, lng) {
    for (const c of countries) {
      let hits = 0;
      for (const r of c.rings) {
        const [minX, minY, maxX, maxY] = r.bbox;
        if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
        if (pointInRing(lng, lat, r.pts)) hits++;
      }
      if (hits % 2 === 1) return c; // odd = inside (outer ring minus holes)
    }
    return null;
  }
  function setHighlight(c) {
    if (hoveredCountry === c) return;
    hoveredCountry = c;
    if (!hlLines) return;
    if (!c || !state.borders) hlLines.geometry.setDrawRange(0, 0);
    else hlLines.geometry.setDrawRange(c.segStart * 2, c.segCount * 2);
  }

  /* ── Cities ──────────────────────────────────────────────────── */
  const cities = window.EARTH_DATA.cities
    .map(([name, a3, lat, lng, pop]) => ({ name, a3, lat, lng, pop, v: llToV3(lat, lng, R * 1.004) }))
    .sort((a, b) => b.pop - a.pop);

  const cityDots = (() => {
    const pos = new Float32Array(cities.length * 3);
    cities.forEach((c, i) => pos.set([c.v.x, c.v.y, c.v.z], i * 3));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const cv = document.createElement('canvas'); cv.width = cv.height = 32;
    const cx = cv.getContext('2d');
    const grad = cx.createRadialGradient(16, 16, 0, 16, 16, 15);
    grad.addColorStop(0, 'rgba(255,224,130,1)');
    grad.addColorStop(0.45, 'rgba(255,209,102,0.85)');
    grad.addColorStop(1, 'rgba(255,209,102,0)');
    cx.fillStyle = grad; cx.fillRect(0, 0, 32, 32);
    const m = new THREE.PointsMaterial({
      size: 1.35, map: new THREE.CanvasTexture(cv), transparent: true,
      depthWrite: false, sizeAttenuation: true,
    });
    const p = new THREE.Points(g, m);
    scene.add(p);
    return p;
  })();

  /* city labels (DOM pool) */
  const labelWrap = $('#labels');
  const labelPool = [];
  for (let i = 0; i < 80; i++) {
    const el = document.createElement('div');
    el.className = 'city-label';
    el.style.display = 'none';
    el.addEventListener('pointerenter', () => { labelHover = el._city || null; });
    el.addEventListener('pointerleave', () => { if (labelHover === el._city) labelHover = null; });
    el.addEventListener('click', (e) => { e.stopPropagation(); if (el._city) flyTo(el._city.lat, el._city.lng, R * 1.5, 1.1); });
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); if (el._city) diveTo(el._city.lat, el._city.lng); });
    labelWrap.appendChild(el);
    labelPool.push(el);
  }
  let labelHover = null;

  const _proj = new THREE.Vector3();
  function projectToScreen(v3, out) {
    _proj.copy(v3).project(camera);
    out.x = (_proj.x * 0.5 + 0.5) * innerWidth;
    out.y = (-_proj.y * 0.5 + 0.5) * innerHeight;
    out.behind = _proj.z > 1;
    return out;
  }
  function cityVisible(c, camDist, camDirN) {
    // beyond-horizon test: visible if angle(city, camera) < acos(R/d)
    return c.v.dot(camDirN) / (R * 1.004) > R / camDist;
  }

  function updateLabels() {
    const camDist = camera.position.length();
    const camDirN = camera.position.clone().normalize();
    const alt = (camDist - R) / R;
    const maxLabels = alt > 3.2 ? 16 : alt > 1.8 ? 28 : alt > 0.8 ? 46 : 72;
    const s = { x: 0, y: 0, behind: false };
    const placed = [];
    let used = 0;
    for (const c of cities) {
      if (used >= maxLabels || used >= labelPool.length) break;
      if (!cityVisible(c, camDist, camDirN)) continue;
      projectToScreen(c.v, s);
      if (s.behind || s.x < -30 || s.x > innerWidth + 30 || s.y < -30 || s.y > innerHeight + 30) continue;
      // cull labels that would overlap an already-placed (larger) city's label
      let clash = false;
      for (let k = placed.length - 1; k >= 0; k--) {
        if (Math.abs(placed[k].y - s.y) < 14 && Math.abs(placed[k].x - s.x) < 74) { clash = true; break; }
      }
      if (clash) continue;
      placed.push({ x: s.x, y: s.y });
      const el = labelPool[used++];
      el.style.display = 'block';
      el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-4px,-50%)`;
      el.style.zIndex = String(2000 - used); // bigger cities stack on top
      if (el._city !== c) { el._city = c; el.textContent = c.name; }
    }
    for (let i = used; i < labelPool.length; i++) {
      if (labelPool[i].style.display !== 'none') { labelPool[i].style.display = 'none'; labelPool[i]._city = null; }
    }
  }

  /* ── Flights ─────────────────────────────────────────────────── */
  const flightGroup = new THREE.Group();
  scene.add(flightGroup);
  (function buildFlights() {
    const airports = window.EARTH_DATA.airports.map(([code, lat, lng]) => ({
      code, v: llToV3(lat, lng, R, new THREE.Vector3()).normalize(),
    }));
    // deterministic PRNG so the route map is stable
    let seed = 1337;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

    const routes = [];
    let guard = 0;
    while (routes.length < 64 && guard++ < 4000) {
      const a = airports[(rnd() * airports.length) | 0];
      const b = airports[(rnd() * airports.length) | 0];
      if (a === b) continue;
      const ang = a.v.angleTo(b.v);
      if (ang < 0.22) continue; // skip hops that are too short to draw nicely
      routes.push({ a: a.v, b: b.v, ang, phase: rnd(), dur: 26 + (ang / Math.PI) * 90 });
    }

    // arcs: one merged LineSegments
    const SEG = 36;
    const pts = [];
    const va = new THREE.Vector3(), vb = new THREE.Vector3();
    const slerp = (A, B, ang, t, out) => {
      const s = Math.sin(ang);
      out.copy(A).multiplyScalar(Math.sin((1 - t) * ang) / s)
         .addScaledVector(B, Math.sin(t * ang) / s);
      return out;
    };
    for (const r of routes) {
      r.alt = 0.015 + 0.085 * (r.ang / Math.PI);
      for (let i = 0; i < SEG; i++) {
        const t0 = i / SEG, t1 = (i + 1) / SEG;
        slerp(r.a, r.b, r.ang, t0, va).multiplyScalar(R * (1 + r.alt * Math.sin(Math.PI * t0)));
        slerp(r.a, r.b, r.ang, t1, vb).multiplyScalar(R * (1 + r.alt * Math.sin(Math.PI * t1)));
        pts.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
      }
    }
    const gArcs = new THREE.BufferGeometry();
    gArcs.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    flightGroup.add(new THREE.LineSegments(gArcs, new THREE.LineBasicMaterial({
      color: 0x35c8ff, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })));

    // planes: one Points cloud, positions updated per frame
    const planePos = new Float32Array(routes.length * 3);
    const gPlanes = new THREE.BufferGeometry();
    gPlanes.setAttribute('position', new THREE.BufferAttribute(planePos, 3));
    const cv = document.createElement('canvas'); cv.width = cv.height = 16;
    const cx = cv.getContext('2d');
    const gr = cx.createRadialGradient(8, 8, 0, 8, 8, 8);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(160,225,255,0.9)'); gr.addColorStop(1, 'rgba(160,225,255,0)');
    cx.fillStyle = gr; cx.fillRect(0, 0, 16, 16);
    const planes = new THREE.Points(gPlanes, new THREE.PointsMaterial({
      size: 1.5, map: new THREE.CanvasTexture(cv), transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    flightGroup.add(planes);
    flightGroup.userData.planeMat = planes.material;

    const tmp = new THREE.Vector3();
    flightGroup.userData.tick = (t) => {
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        let u = ((t / r.dur) + r.phase) % 1;
        slerp(r.a, r.b, r.ang, u, tmp).multiplyScalar(R * (1 + r.alt * Math.sin(Math.PI * u)));
        planePos.set([tmp.x, tmp.y, tmp.z], i * 3);
      }
      gPlanes.attributes.position.needsUpdate = true;
    };
  })();

  /* ── Popup ───────────────────────────────────────────────────── */
  const popup = $('#popup');
  let popupKey = null;
  function showPopup(city, country, x, y) {
    const key = (city ? city.name : '') + '|' + (country ? country.props.a3 || country.props.name : '');
    if (key !== popupKey) {
      popupKey = key;
      let html = '';
      if (city) {
        html += `<div class="p-city">🏙️ <b>${city.name}</b> · urban pop ≈ ${fmtPop(city.pop)}</div>`;
      }
      if (country) {
        const p = country.props;
        html += `<div class="p-title"><span class="flag">${flagEmoji(p.a2)}</span>${p.name}</div>
          <table>
            <tr><td>Capital</td><td>${p.capital || '—'}</td></tr>
            <tr><td>Area</td><td>${fmtArea(p.area)}</td></tr>
            <tr><td>Population</td><td>${fmtPop(p.pop)}</td></tr>
            <tr><td>GDP (nominal)</td><td>${fmtGdp(p.gdp)}</td></tr>
            <tr><td>GDP per capita</td><td>${fmtGdpPc(p.gdp, p.pop)}</td></tr>
          </table>`;
      }
      html += `<div class="p-dive">double-click to dive to the streets</div>`;
      popup.innerHTML = html;
      popup.classList.remove('hidden');
    }
    const pw = popup.offsetWidth, ph = popup.offsetHeight;
    let px = x + 18, py = y + 16;
    if (px + pw > innerWidth - 8) px = x - pw - 14;
    if (py + ph > innerHeight - 8) py = y - ph - 12;
    popup.style.left = px + 'px';
    popup.style.top = py + 'px';
  }
  function hidePopup() {
    if (popupKey !== null) { popupKey = null; popup.classList.add('hidden'); }
  }

  /* ── Hover picking ───────────────────────────────────────────── */
  const raycaster = new THREE.Raycaster();
  const mouse = { x: -1e4, y: -1e4, ndc: new THREE.Vector2(), fresh: false, down: false };
  let hoveredCity = null;

  function onPointerMove(e) {
    mouse.x = e.clientX; mouse.y = e.clientY;
    mouse.ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    mouse.fresh = true;
  }
  canvas.addEventListener('pointermove', onPointerMove);
  labelWrap.addEventListener('pointermove', onPointerMove); // labels swallow canvas events
  canvas.addEventListener('pointerleave', () => { mouse.x = -1e4; hidePopup(); setHighlight(null); });

  function pickCity() {
    // nearest projected city within 15px wins; a hovered DOM label is the fallback
    const camDist = camera.position.length();
    const camDirN = camera.position.clone().normalize();
    const s = { x: 0, y: 0, behind: false };
    let best = null, bestD = 15 * 15;
    for (const c of cities) {
      if (!cityVisible(c, camDist, camDirN)) continue;
      projectToScreen(c.v, s);
      if (s.behind) continue;
      const dx = s.x - mouse.x, dy = s.y - mouse.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best || labelHover;
  }

  let hoverCooldown = 0;
  function updateHover() {
    if (state.mapMode || mouse.down) return;
    if (!mouse.fresh && --hoverCooldown > 0) return;
    hoverCooldown = 6; // re-pick every few frames while the globe auto-rotates
    mouse.fresh = false;
    if (mouse.x < -1e3) return;

    raycaster.setFromCamera(mouse.ndc, camera);
    const hit = raycaster.intersectObject(earth, false)[0];
    canvas.classList.remove('on-land', 'on-city');
    if (!hit) { hidePopup(); setHighlight(null); hoveredCity = null; return; }

    hoveredCity = pickCity();
    let country;
    if (hoveredCity) {
      country = countryAt(hoveredCity.lat, hoveredCity.lng);
    } else {
      const ll = v3ToLL(hit.point);
      country = countryAt(ll.lat, ll.lng);
    }
    if (hoveredCity || country) {
      canvas.classList.add(hoveredCity ? 'on-city' : 'on-land');
      setHighlight(country || null);
      showPopup(hoveredCity, country, mouse.x, mouse.y);
    } else {
      setHighlight(null);
      hidePopup();
    }
  }

  /* ── Camera fly-to animation ─────────────────────────────────── */
  let tween = null;
  function flyTo(lat, lng, dist, dur, onDone) {
    const from = camera.position.clone();
    const fromDist = from.length();
    const fromN = from.clone().normalize();
    const toN = llToV3(lat, lng, 1, new THREE.Vector3()).normalize();
    const qa = new THREE.Quaternion();
    const qFrom = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fromN);
    const qTo = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), toN);
    const t0 = performance.now();
    const ms = (dur || 1.2) * 1000;
    controls.enabled = false;
    tween = (now) => {
      let t = clamp((now - t0) / ms, 0, 1);
      t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
      qa.slerpQuaternions(qFrom, qTo, t);
      const d = fromDist + (dist - fromDist) * t;
      camera.position.set(0, 0, 1).applyQuaternion(qa).multiplyScalar(d);
      camera.lookAt(0, 0, 0);
      if (t >= 1) {
        tween = null;
        controls.enabled = true;
        controls.update();
        if (onDone) onDone();
      }
    };
  }
  canvas.addEventListener('pointerdown', () => { tween = null; controls.enabled = true; });

  /* ── Street-map mode (Leaflet) ───────────────────────────────── */
  let map = null, tileDay = null, tileNight = null, activeTile = null, diveMarker = null;
  let exitZoom = 4, diveTime = 0;

  function metersPerPixelAt(dist) {
    const groundDist = Math.max(dist - R, 0.001);
    const unitsPerPx = 2 * groundDist * Math.tan(FOV * DEG / 2) / canvas.clientHeight;
    return unitsPerPx * EARTH_M_PER_UNIT;
  }
  function leafletZoomFor(mpp, lat) {
    return Math.log2(156543.03392 * Math.cos(lat * DEG) / mpp);
  }

  function ensureMap() {
    if (map) return;
    map = L.map('map', {
      center: [0, 0], zoom: 3, zoomSnap: 0.25, zoomDelta: 0.5,
      worldCopyJump: true, zoomControl: true, attributionControl: true,
    });
    tileDay = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    });
    tileNight = L.tileLayer('https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, subdomains: 'abcd',
      attribution: '© OpenStreetMap contributors © CARTO',
    });
    map.on('zoomend', () => {
      // grace period so setView/minZoom churn during the dive can't bounce us out
      if (state.mapMode && performance.now() - diveTime > 700 && map.getZoom() <= exitZoom) exitMap();
    });
  }
  function pickTileLayer() {
    const wantNight = state.lightMode === 'night';
    const want = wantNight ? tileNight : tileDay;
    if (activeTile === want) return;
    if (activeTile) map.removeLayer(activeTile);
    activeTile = want.addTo(map);
  }

  function diveTo(lat, lng) {
    if (state.mapMode) return;
    ensureMap();
    const dist = camera.position.length();
    const z = clamp(leafletZoomFor(metersPerPixelAt(dist), lat), 3, 19);
    exitZoom = Math.max(3.5, z - 2.5);
    diveTime = performance.now();
    // set the option directly — setMinZoom() would kick off an animated zoom
    // from the map's stale zoom level and stomp the setView below
    map.options.minZoom = Math.floor(exitZoom - 0.25);
    map.setView([lat, lng], Math.round(z * 4) / 4, { animate: false });
    pickTileLayer();
    if (diveMarker) map.removeLayer(diveMarker);
    diveMarker = L.circleMarker([lat, lng], {
      radius: 7, color: '#53d1ff', weight: 2, fillColor: '#53d1ff', fillOpacity: 0.25,
    }).addTo(map);

    state.mapMode = true;
    hidePopup(); setHighlight(null);
    $('#map-wrap').classList.add('active');
    $('#map-wrap').setAttribute('aria-hidden', 'false');
    setTimeout(() => { map.invalidateSize(); running && requestRender(); }, 60);
    // free the GPU while the map is fullscreen
    setTimeout(() => { if (state.mapMode) setLoop(false); }, 600);
  }

  function exitMap() {
    if (!state.mapMode) return;
    state.mapMode = false;
    const c = map.getCenter();
    const mpp = 156543.03392 * Math.cos(c.lat * DEG) / Math.pow(2, map.getZoom());
    const groundDist = mpp / EARTH_M_PER_UNIT * canvas.clientHeight / (2 * Math.tan(FOV * DEG / 2));
    const d = clamp(R + groundDist, MIN_DIST, MAX_DIST);
    camera.position.copy(llToV3(c.lat, c.lng, d, new THREE.Vector3()));
    camera.lookAt(0, 0, 0);
    controls.update();
    setLoop(true);
    $('#map-wrap').classList.remove('active');
    $('#map-wrap').setAttribute('aria-hidden', 'true');
  }

  $('#btn-orbit').addEventListener('click', exitMap);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') exitMap(); });

  /* dive triggers */
  canvas.addEventListener('dblclick', (e) => {
    const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(earth, false)[0];
    if (!hit) return;
    const ll = v3ToLL(hit.point);
    flyTo(ll.lat, ll.lng, MIN_DIST * 1.001, 1.05, () => diveTo(ll.lat, ll.lng));
  });
  let diveCharge = 0;
  canvas.addEventListener('wheel', (e) => {
    if (state.mapMode) return;
    if (e.deltaY < 0 && camera.position.length() <= MIN_DIST * 1.02) {
      if (++diveCharge >= 2) {
        diveCharge = 0;
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        const hit = raycaster.intersectObject(earth, false)[0];
        const ll = hit ? v3ToLL(hit.point) : v3ToLL(camera.position);
        diveTo(ll.lat, ll.lng);
      }
    } else if (e.deltaY > 0) diveCharge = 0;
  }, { passive: true });

  /* ── UI wiring ───────────────────────────────────────────────── */
  $('#seg-light').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.lightMode = btn.dataset.mode;
    document.querySelectorAll('#seg-light button').forEach((b) => b.classList.toggle('active', b === btn));
    earthUniforms.nightBoost.value = state.lightMode === 'night' ? 1.25 : 1.0;
    if (map && state.mapMode) pickTileLayer();
  });
  $('#tgl-clouds').addEventListener('change', (e) => {
    state.clouds = e.target.checked;
    clouds.visible = state.clouds && !!cloudMat.alphaMap;
  });
  $('#tgl-flights').addEventListener('change', (e) => {
    state.flights = e.target.checked;
    flightGroup.visible = state.flights;
  });
  $('#tgl-borders').addEventListener('change', (e) => {
    state.borders = e.target.checked;
    if (borderLines) borderLines.visible = state.borders;
    if (!state.borders) setHighlight(null);
  });
  $('#tgl-spin').addEventListener('change', (e) => {
    state.spin = e.target.checked;
  });

  /* pause auto-rotate while the user interacts; resume after idle */
  let interactPause = false, idleTimer = null;
  controls.addEventListener('start', () => {
    canvas.classList.add('dragging');
    interactPause = true;
    clearTimeout(idleTimer);
  });
  controls.addEventListener('end', () => {
    canvas.classList.remove('dragging');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { interactPause = false; }, 10000);
  });
  canvas.addEventListener('pointerdown', () => { mouse.down = true; hidePopup(); });
  addEventListener('pointerup', () => { mouse.down = false; });

  /* ── Resize / visibility ─────────────────────────────────────── */
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    if (map) map.invalidateSize();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setLoop(false);
    else if (!state.mapMode) setLoop(true);
  });

  /* ── Main loop ───────────────────────────────────────────────── */
  const clock = new THREE.Clock();
  let running = false;
  let elapsed = 0;

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);
    elapsed += dt;

    if (tween) tween(performance.now());

    // controls feel scales with altitude
    const dist = camera.position.length();
    const alt = (dist - R) / R;
    controls.rotateSpeed = clamp(alt * 0.85, 0.045, 0.9);
    controls.zoomSpeed = clamp(alt * 1.15, 0.22, 1.05);
    // OrbitControls auto-rotation is per-frame; rescale by dt so speed is fps-independent.
    // Hold the spin while a popup is open so countries don't slide away mid-read.
    controls.autoRotateSpeed = AUTOROT_BASE * dt * 60;
    controls.autoRotate = state.spin && !interactPause && popupKey === null;
    if (!tween) controls.update();

    // keep point sprites at a steady on-screen size across zoom levels
    cityDots.material.size = clamp(alt * 0.5 + 0.02, 0.06, 1.35);
    flightGroup.userData.planeMat.size = clamp(alt * 0.55 + 0.05, 0.14, 1.6);

    // sun
    updateSunTarget();
    sunDir.lerp(sunTarget, 1 - Math.pow(0.0018, dt)).normalize();
    sunLight.position.copy(sunDir).multiplyScalar(800);

    // slow ambient motion
    clouds.rotation.y += dt * 0.0045;
    stars.rotation.y += dt * 0.0012;

    if (state.flights) flightGroup.userData.tick(elapsed);

    updateLabels();
    updateHover();

    renderer.render(scene, camera);
  }
  function setLoop(on) {
    if (on === running) return;
    running = on;
    renderer.setAnimationLoop(on ? frame : null);
  }
  function requestRender() { renderer.render(scene, camera); }

  /* ── Boot: fetch country data, then go ───────────────────────── */
  fetch('assets/data/world.geo.json')
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((geo) => {
      buildCountries(geo);
      tickLoad('building the planet…');
      // start over the currently sunlit hemisphere
      const s = realSunDir(new THREE.Vector3());
      const ll = v3ToLL(s);
      camera.position.copy(llToV3(clamp(ll.lat + 8, -60, 60), ll.lng - 18, R * 3.1, new THREE.Vector3()));
      camera.lookAt(0, 0, 0);
      sunDir.copy(s);
      controls.update();
      state.ready = true;
      setLoop(true);
      setTimeout(() => $('#loading').classList.add('done'), 350);
    })
    .catch((err) => {
      console.error(err);
      fatal(
        'Could not load <code>assets/data/world.geo.json</code>.<br>' +
        'If you opened this file directly, please serve it instead:<br>' +
        '<code>npm start</code> or <code>python -m http.server</code> — or visit the GitHub Pages site.'
      );
    });

  /* ── Test / debug hooks ──────────────────────────────────────── */
  window.__APP = {
    get ready() { return state.ready; },
    state, camera, controls, renderer, scene,
    flyTo, diveTo, exitMap,
    project: (lat, lng) => {
      const s = projectToScreen(llToV3(lat, lng, R * 1.004, new THREE.Vector3()), { x: 0, y: 0, behind: false });
      return { x: s.x, y: s.y, behind: s.behind };
    },
    hoveredName: () => (hoveredCountry ? hoveredCountry.props.name : null),
    hoveredCityName: () => (hoveredCity ? hoveredCity.name : null),
    countryAt,
    getMap: () => map,
    azimuth: () => Math.atan2(camera.position.x, camera.position.z),
  };
})();
