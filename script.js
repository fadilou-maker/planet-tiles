    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

    // ---------- Planet constants ----------
    const BASE_RADIUS = 12;          // planet radius; moons declare their own
    const SEA_LEVEL   = 0.0;         // ocean sits at body.baseRadius (heights[i] == 0)
    const ICO_DETAIL  = 7;           // planet detail; finer triangles for smoother brush strokes

    // Biome height bands (relative to sea level). Below sea level is hidden by the
    // water sphere, so colors there only show if the brush carves below water.
    const SAND_TOP   = 0.25;
    const GRASS_TOP  = 1.2;
    const ROCK_TOP   = 2.4;
    // Above ROCK_TOP we fade into snow over SNOW_FADE units.
    const SNOW_FADE  = 0.4;

    const COL = {
      water:     0x3FA1DC,
      deep:      0x12243a,
      shore:     0x8fb4c8,
      sand:      0xEDDFB8,
      grass:     0x4FAE4F,
      grassDark: 0x2f7a36,
      rock:      0x7d6a5a,
      snow:      0xf0f4f8,
      forest:    0x1a4d1a,
      desert:    0xd2b48c,
      city:      0x808080,
      cityLights:0xffd700,
    };

    const BIOME = {
      AUTO: 0,
      FOREST: 1,
      DESERT: 2,
      TUNDRA: 4,
      // Moon-only biomes: a deliberately small palette of three.
      MARE: 40,
      REGOLITH: 41,
      FROST: 42,
    };

    const MOON_BIOME_OPTIONS = [
      { v: BIOME.MARE,     n: 'Mare' },
      { v: BIOME.REGOLITH, n: 'Regolith' },
      { v: BIOME.FROST,    n: 'Frost' },
    ];

    // ---------- Scene ----------
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02030a);

    // Far clip is generous so that the system view can frame multiple planets
    // on wide orbits (and stay behind the starfield at r=320).
    const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 4000);
    camera.position.set(0, 15, 28);

    const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    // Paint mode default ON — right-button is reserved for the brush, not pan.
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: null,
    };

    // Sun is the only light source — night side stays black. A PointLight at
    // the sun's origin gives every body its own correct (sun → body)
    // direction automatically; a DirectionalLight only has one parallel
    // direction and would light non-focused planets from the wrong angle.
    const SUN_RADIUS = 18;
    const SUN_FAR    = 1400; // shadow camera far — must clear the outermost orbit
    const sun = new THREE.PointLight(0xfff1d4, 1.50, 0, 0); // distance=0, decay=0 → uniform brightness
    sun.position.set(0, 0, 0);
    sun.castShadow = true;
    // PointLight uses a cube shadow map (6 faces); 1024² per face keeps GPU
    // memory reasonable (~24MB) while still giving crisp terrain shadows.
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = SUN_RADIUS + 0.5;
    sun.shadow.camera.far  = SUN_FAR;
    sun.shadow.bias        = -0.0005;
    scene.add(sun);

    const sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(SUN_RADIUS, 48, 24),
      new THREE.MeshBasicMaterial({ color: 0xfff0c0, fog: false })
    );
    // Sun anchors the system center; planets orbit around (0,0,0).
    sunMesh.position.set(0, 0, 0);
    scene.add(sunMesh);

    // ---------- Palettes ----------
    const PLANET_PALETTE = {
      deep:  COL.deep,
      shore: COL.shore,
      sand:  COL.sand,
      grass: COL.grass,
      rock:  COL.rock,
      snow:  COL.snow,
    };

    const MOON_PALETTE = {
      crater:    0x322e29,
      dust:      0x6f6357,
      rock:      0xa49a8b,
      highlight: 0xe2dccf,
    };

    // ---------- Body framework ----------
    // A "body" is a planet or moon: an icosphere whose vertices each store a unit
    // direction and a signed height. World radius at vertex i is
    // baseRadius * (1 + heights[i] * BODY_HEIGHT_SCALE) — relative so peak heights
    // stay proportional across bodies of very different sizes.
    const BODY_HEIGHT_SCALE = 0.025;

    // Hard caps on heights[i]. Keeps mountains proportional to the body — a peak at
    // MAX_LAND_HEIGHT sits ~MAX_LAND_HEIGHT * BODY_HEIGHT_SCALE * 100% above sea level
    // (≈6% of radius at the values below), so the brush can't grow needle-spikes.
    const MAX_LAND_HEIGHT = 2.5;
    const MIN_LAND_HEIGHT = -2.5;

    const bodies = [];

    function smoothstep(a, b, x) {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    }

    // ---------- Gas shader ----------
    // Two visual modes share the same material:
    //   uMode = 0  →  Atmosphere: noise-thresholded clouds + soft edge haze. The
    //                shell is mostly transparent with sparse clumps drifting across.
    //   uMode = 1  →  Full gas (gas giants): subtle latitudinal banding + fresnel
    //                falloff at the silhouette so the body doesn't read as a hard
    //                sphere — instead the edge "stems out" softly into space.
    // Noise is sampled in the mesh's *local* normal so cloud positions stay stable
    // when gasThickness rescales the shell.
    const GAS_VERT = /* glsl */ `
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      varying vec3 vLocalNormal;
      void main() {
        vLocalNormal = normalize(position);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `;
    const GAS_FRAG = /* glsl */ `
      precision highp float;
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      varying vec3 vLocalNormal;
      uniform vec3  uColor;
      uniform vec3  uSunDir;
      uniform float uDensity;
      uniform float uMode;       // 0 = atmosphere, 1 = full gas
      uniform float uCoverage;   // 0 = empty sky, 1 = total overcast (atmosphere only)

      // Cheap value-noise FBM. Good enough for cloud shapes at this scale.
      float hash3(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float vnoise(vec3 x) {
        vec3 p = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash3(p + vec3(0,0,0));
        float n100 = hash3(p + vec3(1,0,0));
        float n010 = hash3(p + vec3(0,1,0));
        float n110 = hash3(p + vec3(1,1,0));
        float n001 = hash3(p + vec3(0,0,1));
        float n101 = hash3(p + vec3(1,0,1));
        float n011 = hash3(p + vec3(0,1,1));
        float n111 = hash3(p + vec3(1,1,1));
        return mix(
          mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
          mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
          f.z);
      }
      float fbm(vec3 x) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * vnoise(x);
          x *= 2.1;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        float NdotV = clamp(abs(dot(vWorldNormal, vViewDir)), 0.0, 1.0);
        float fr = 1.0 - NdotV;                  // 1 at silhouette, 0 at center
        float n  = fbm(vLocalNormal * 3.5);      // 0..1 cloud field

        vec3  col = uColor;
        float alpha;

        if (uMode < 0.5) {
          // Atmosphere: sparse cloud clumps. uCoverage slides the noise threshold
          // so 0 → almost no clouds and 1 → near-total overcast. No rim haze
          // and an explicit limb-fade so the shell doesn't read as a visible
          // dome around the body — the user only sees scattered clouds.
          float thresh = 0.95 - uCoverage * 0.90; // 0.95 (empty) .. 0.05 (overcast)
          float cloud = smoothstep(thresh, thresh + 0.18, n);
          float limbFade = smoothstep(0.0, 0.35, NdotV);
          alpha = cloud * uDensity * 1.6 * limbFade;
        } else {
          // Full gas: gentle banding gives the Jupiter-stripe feel without
          // explicit textures. Fresnel falloff softens the silhouette.
          float bands = 0.5 + 0.5 * sin(vLocalNormal.y * 6.0 + n * 2.5);
          col = mix(uColor * 0.82, uColor * 1.06, bands);
          // Dense at center, fading right to zero at the rim so the silhouette
          // feathers out — the body looks like it "stems from" the center
          // instead of being clipped to a hard circle.
          float core = smoothstep(0.0, 0.40, NdotV);
          alpha = uDensity * core;
        }

        // Sun lighting: dim the night side but keep clouds slightly visible.
        float lambert = max(0.0, dot(vWorldNormal, normalize(uSunDir)));
        float light   = mix(0.30, 1.10, lambert);
        col *= light;

        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
      }
    `;

    function makeGasMaterial() {
      return new THREE.ShaderMaterial({
        vertexShader: GAS_VERT,
        fragmentShader: GAS_FRAG,
        uniforms: {
          uColor:    { value: new THREE.Color(0xffffff) },
          uSunDir:   { value: new THREE.Vector3(1, 0, 0) }, // overwritten per-frame by updateSunLightForFocus
          uDensity:  { value: 0.18 },
          uMode:     { value: 0.0 },
          uCoverage: { value: 0.35 },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
      });
    }

    // ---------- Ring shader ----------
    // Procedural Saturn-like ring banding. The geometry is a flat annulus in the
    // body's local XZ plane; the fragment shader uses the local radius to drive
    // band brightness, two Cassini-like gaps, and an inner/outer soft edge.
    // Planet shadow is cast onto the ring by projecting the fragment relative to
    // the body center along the sun direction (world-space, refreshed per-frame).
    const RING_VERT = /* glsl */ `
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      void main() {
        vLocalPos = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `;
    const RING_FRAG = /* glsl */ `
      precision highp float;
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      uniform float uInner;
      uniform float uOuter;
      uniform float uIntensity;
      uniform vec3  uColorA;
      uniform vec3  uColorB;
      uniform vec3  uSunDir;
      uniform vec3  uBodyCenter;
      uniform float uBodyRadius;

      float hash11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
      float noise1(float x) {
        float i = floor(x);
        float f = fract(x);
        float u = f * f * (3.0 - 2.0 * f);
        return mix(hash11(i), hash11(i + 1.0), u);
      }
      float fbm1(float x) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * noise1(x);
          x *= 2.0;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        float r = length(vLocalPos);
        float t = (r - uInner) / max(1e-4, uOuter - uInner);
        if (t < 0.0 || t > 1.0) discard;

        // Radial banding — fbm gives organic variation; the sin term adds finer
        // ridges so close-up shots still read as many distinct rings.
        float bands = fbm1(t * 18.0);
        bands = mix(bands, 0.5 + 0.5 * sin(t * 120.0), 0.15);

        // Two darker gaps mimicking Cassini/Encke-style divisions.
        float gapMask = 1.0;
        gapMask *= 1.0 - (smoothstep(0.40, 0.42, t) - smoothstep(0.44, 0.46, t));
        gapMask *= 1.0 - (smoothstep(0.72, 0.74, t) - smoothstep(0.76, 0.78, t));

        vec3 col = mix(uColorA, uColorB, clamp(bands, 0.0, 1.0));

        // Soft inner & outer edge so the ring fades into space, not a hard line.
        float edge = smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.94, 1.0, t));

        // Light both faces of the ring — abs() so the lit side flips correctly
        // as the camera moves to the other side of the equatorial plane.
        float light = max(0.25, abs(dot(normalize(vWorldNormal), normalize(uSunDir))));

        // Planet-cast shadow: a fragment behind the body (along the sun line)
        // and within ~bodyRadius of the body axis is occluded. smoothstep gives
        // a soft umbra edge instead of a hard cutout.
        vec3 rel = vWorldPos - uBodyCenter;
        vec3 sd = normalize(uSunDir);
        float along = dot(rel, sd);
        float shadow = 1.0;
        if (along < 0.0) {
          vec3 perp = rel - along * sd;
          float d = length(perp);
          shadow = smoothstep(uBodyRadius * 0.95, uBodyRadius * 1.10, d);
        }

        float alpha = uIntensity * (0.28 + 0.72 * bands) * gapMask * edge;
        gl_FragColor = vec4(col * light * mix(0.30, 1.0, shadow), clamp(alpha, 0.0, 1.0));
      }
    `;

    // Inner/outer factors are multiples of body.baseRadius — rings auto-fit any
    // planet size because both the geometry and the shader's uInner/uOuter are
    // derived from baseRadius. Body group scale then carries the ring to its
    // final world size.
    const RING_INNER_FACTOR = 1.40;
    const RING_OUTER_FACTOR = 2.30;

    function makeRingMaterial() {
      return new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: {
          uInner:      { value: 1.0 },
          uOuter:      { value: 2.0 },
          uIntensity:  { value: 0.65 },
          uColorA:     { value: new THREE.Color(0x8a6b3a) }, // dusty brown
          uColorB:     { value: new THREE.Color(0xe8d2a0) }, // pale ice
          uSunDir:     { value: new THREE.Vector3(1, 0, 0) }, // refreshed per-frame
          uBodyCenter: { value: new THREE.Vector3() },
          uBodyRadius: { value: 1.0 },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    }

    function createBody({ kind, name, baseRadius, detail, palette, hasOcean, initialHeight = -0.5 }) {
      const geo = new THREE.IcosahedronGeometry(baseRadius, detail).toNonIndexed();
      const posAttr = geo.attributes.position;
      const N = posAttr.count;
      const unitDirs = new Float32Array(N * 3);
      const heights  = new Float32Array(N);
      const biomes   = new Uint8Array(N); // 0 = auto, 1 = forest, 2 = desert, 3 = city, 4 = tundra
      for (let i = 0; i < N; i++) {

        const x = posAttr.array[3 * i];
        const y = posAttr.array[3 * i + 1];
        const z = posAttr.array[3 * i + 2];
        const inv = 1 / Math.hypot(x, y, z);
        unitDirs[3 * i]     = x * inv;
        unitDirs[3 * i + 1] = y * inv;
        unitDirs[3 * i + 2] = z * inv;
        heights[i] = initialHeight;
      }
      const colorArr = new Float32Array(N * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.92,
        metalness: 0.0,
        flatShading: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const group = new THREE.Group();
      group.add(mesh);

      // Liquid layer (ocean) — always created so toggling an archetype that adds
      // an ocean later actually shows water instead of bare deep-color terrain.
      const oceanMesh = new THREE.Mesh(
        new THREE.SphereGeometry(baseRadius, 96, 64),
        new THREE.MeshStandardMaterial({
          color: COL.water,
          roughness: 0.30,
          metalness: 0.05,
          transparent: true,
          opacity: 0.92,
        })
      );
      oceanMesh.receiveShadow = true;
      oceanMesh.visible = !!hasOcean;
      group.add(oceanMesh);

      // Gas layer — translucent shell driven by a custom shader so atmospheres
      // look like sparse clouds and gas giants get a feathered silhouette.
      // depthWrite:false (set on the material) avoids z-fighting with the
      // solid/liquid meshes when the shell sits just outside them.
      const gasMesh = new THREE.Mesh(
        new THREE.SphereGeometry(baseRadius, 64, 48),
        makeGasMaterial()
      );
      gasMesh.visible = false;
      gasMesh.renderOrder = 1; // render after the solid mesh so transparency blends right
      group.add(gasMesh);

      // Ring annulus, only meaningful on planets. RingGeometry is built in the
      // XY plane; rotating −π/2 around X lays it flat in the body's equatorial
      // (XZ) plane. Rings have rotational symmetry about Y so the planet's
      // daily spin (group.rotation.y) doesn't visually drag them along.
      const ringInner = baseRadius * RING_INNER_FACTOR;
      const ringOuter = baseRadius * RING_OUTER_FACTOR;
      const ringMesh = new THREE.Mesh(
        new THREE.RingGeometry(ringInner, ringOuter, 192, 4),
        makeRingMaterial()
      );
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.material.uniforms.uInner.value = ringInner;
      ringMesh.material.uniforms.uOuter.value = ringOuter;
      ringMesh.material.uniforms.uBodyRadius.value = baseRadius;
      ringMesh.visible = false;
      ringMesh.renderOrder = 2;
      group.add(ringMesh);

      const body = {
        kind, name, baseRadius, detail,
        palette: palette || (kind === 'planet' ? PLANET_PALETTE : MOON_PALETTE),
        group, mesh, geo, posAttr, N, unitDirs, heights, biomes, colorArr,
        oceanMesh, gasMesh, ringMesh,
        // Matter state. Moons keep matter.gas false; planets inherit from
        // ARCHETYPE_MATTER on regenerate.
        matter: { solid: true, liquid: !!hasOcean, gas: false },
        gasMode: 'none',
        gasThickness: 1.10,
        gasDensity: 0.18,
        gasCoverage: 0.35,
        rings: { enabled: false, intensity: 0.65 },
      };

      for (let i = 0; i < N; i++) {
        writeBodyVertex(body, i);
        colorBodyVertex(body, i);
      }
      commitBodyChanges(body);
      return body;
    }

    function writeBodyVertex(body, i) {
      const r = body.baseRadius * (1 + body.heights[i] * BODY_HEIGHT_SCALE);
      body.posAttr.array[3 * i]     = body.unitDirs[3 * i]     * r;
      body.posAttr.array[3 * i + 1] = body.unitDirs[3 * i + 1] * r;
      body.posAttr.array[3 * i + 2] = body.unitDirs[3 * i + 2] * r;
    }

    function colorBodyVertex(body, i) {
      const h = body.heights[i];
      const b = body.biomes[i];
      const p = body.palette;
      let c;

      if (b === BIOME.FOREST) {
        c = new THREE.Color(COL.forest);
        const mix = smoothstep(GRASS_TOP, ROCK_TOP, h);
        c.lerp(new THREE.Color(COL.grassDark), mix * 0.3);
      } else if (b === BIOME.DESERT) {
        c = new THREE.Color(COL.desert);
        const mix = smoothstep(SEA_LEVEL, SAND_TOP, h);
        c.lerp(new THREE.Color(COL.sand), mix * 0.2);
      } else if (b === BIOME.TUNDRA) {
        c = new THREE.Color(COL.snow);
        c.lerp(new THREE.Color(COL.shore), 0.1);
      } else if (b === 5) { // Obsidian
        c = new THREE.Color(0x1a1a1a);
      } else if (b === 6) { // Magma Flow
        c = new THREE.Color(0xff4500);
        if ((i * 7) % 10 > 5) c.lerp(new THREE.Color(0xff8c00), 0.5);
      } else if (b === 7) { // Circuitry
        c = new THREE.Color(0x00f2ff);
        if ((i * 13) % 10 > 3) c = new THREE.Color(0x0a0a0a);
      } else if (b === 8) { // Plating
        c = new THREE.Color(0x444444);
        if ((i * 3) % 10 > 7) c = new THREE.Color(0x666666);
      } else if (b === 11) { // Coral Reef
        c = new THREE.Color(0xff7f50);
        if ((i * 3) % 10 > 5) c = new THREE.Color(0xff69b4);
      } else if (b === 12) { // Kelp Forest
        c = new THREE.Color(0x2e8b57);
      } else if (b === 13) { // Abyssal Trench
        c = new THREE.Color(0x000033);
      } else if (b === 14) { // Sulfur Vent
        c = new THREE.Color(0xffff00);
      } else if (b === 15) { // Oasis
        c = new THREE.Color(0x228b22);
      } else if (b === 16) { // Ancient Ruins
        c = new THREE.Color(0x808080);
        if ((i * 11) % 10 > 7) c = new THREE.Color(0x00f2ff); // glowing ruins
      } else if (b === 17) { // Red Sand
        c = new THREE.Color(0x8b0000);
      } else if (b === 18) { // Glacier
        c = new THREE.Color(0xe0ffff);
      } else if (b === 19) { // Cryo-Volcano
        c = new THREE.Color(0xadd8e6);
        if ((i * 5) % 10 > 8) c = new THREE.Color(0xffffff);
      } else if (b === 21) { // Exotic Bloom
        c = new THREE.Color(0xff00ff);
      } else if (b === 24) { // Data Hub
        c = new THREE.Color(0x00f2ff);
        textShadow: '0 0 10px #00f2ff';
      } else if (b === 26) { // Rust
        c = new THREE.Color(0x8b4513);
      } else if (b === 27) { // Gold
        c = new THREE.Color(0xffd700);
      } else if (b === 29) { // Neural
        c = new THREE.Color(0xff69b4);
        if ((i * 2) % 10 > 8) c = new THREE.Color(0xffffff);
      } else if (b === 32) { // Lightning
        c = new THREE.Color(0xffffff);
        if ((i * 17) % 10 > 2) c = new THREE.Color(0x4b0082);
      } else if (b === BIOME.MARE) { // Dark basalt plains
        c = new THREE.Color(0x2a2a30);
        if ((i * 7) % 10 > 8) c = new THREE.Color(0x3a3a42);
      } else if (b === BIOME.REGOLITH) { // Bright lunar dust
        c = new THREE.Color(0xc4b8a0);
        if ((i * 3) % 10 > 6) c = new THREE.Color(0xd6cdb6);
      } else if (b === BIOME.FROST) { // Polar ice patches
        c = new THREE.Color(0xd8e8f0);
        if ((i * 5) % 10 > 7) c = new THREE.Color(0xffffff);
      } else if (body.kind === 'planet') {
        if (h < -0.4) c = new THREE.Color(p.deep);
        else if (h < SEA_LEVEL) {
          const t = (h + 0.4) / (SEA_LEVEL + 0.4);
          c = new THREE.Color(p.deep).lerp(new THREE.Color(p.shore), t);
        } else if (h < SAND_TOP) c = new THREE.Color(p.sand);
        else if (h < GRASS_TOP) {
          const t = smoothstep(SAND_TOP, SAND_TOP + 0.15, h);
          c = new THREE.Color(p.sand).lerp(new THREE.Color(p.grass), t);
        } else if (h < ROCK_TOP) {
          const t = smoothstep(GRASS_TOP, GRASS_TOP + 0.4, h);
          c = new THREE.Color(p.grass).lerp(new THREE.Color(p.rock), t);
        } else {
          const t = smoothstep(ROCK_TOP, ROCK_TOP + SNOW_FADE, h);
          c = new THREE.Color(p.rock).lerp(new THREE.Color(p.snow), t);
        }
      } else {
        // Moon logic stays same
        if (h < -0.6) c = new THREE.Color(p.crater);
        else if (h < 0) {
          const t = (h + 0.6) / 0.6;
          c = new THREE.Color(p.crater).lerp(new THREE.Color(p.dust), t);
        } else if (h < GRASS_TOP) {
          const t = smoothstep(0, GRASS_TOP, h);
          c = new THREE.Color(p.dust).lerp(new THREE.Color(p.rock), t);
        } else {
          const t = smoothstep(ROCK_TOP, ROCK_TOP + SNOW_FADE, h);
          c = new THREE.Color(p.rock).lerp(new THREE.Color(p.highlight), t);
        }
      }
      body.colorArr[3 * i]     = c.r;
      body.colorArr[3 * i + 1] = c.g;
      body.colorArr[3 * i + 2] = c.b;
    }

    function commitBodyChanges(body) {
      body.posAttr.needsUpdate = true;
      body.geo.attributes.color.needsUpdate = true;
      body.geo.computeVertexNormals();
    }

    // Reads brushRadius / brushStrength / brushRaise from the module-scope state
    // declared further below — those values exist at call time (animate loop).
    function applyBrushToBody(body, centerLocal, dt) {
      const cx = centerLocal.x, cy = centerLocal.y, cz = centerLocal.z;
      const invLen = 1 / Math.hypot(cx, cy, cz);
      const ux = cx * invLen, uy = cy * invLen, uz = cz * invLen;

      const cosCut = Math.cos(brushRadius);
      const dir = brushRaise ? 1 : -1;
      const delta = dir * brushStrength * dt;

      let touchedAny = false;
      for (let i = 0; i < body.N; i++) {
        const dx = body.unitDirs[3 * i];
        const dy = body.unitDirs[3 * i + 1];
        const dz = body.unitDirs[3 * i + 2];
        const dot = dx * ux + dy * uy + dz * uz;
        if (dot <= cosCut) continue;

        if (currentTool === 'land') {
          const ang = Math.acos(Math.min(1, dot));
          const t = ang / brushRadius;
          const f = 1 - t * t;
          const falloff = f * f;
          const next = body.heights[i] + delta * falloff;
          body.heights[i] = next < MIN_LAND_HEIGHT ? MIN_LAND_HEIGHT
                          : next > MAX_LAND_HEIGHT ? MAX_LAND_HEIGHT
                          : next;
          writeBodyVertex(body, i);
        } else {
          // Biome painting
          body.biomes[i] = selectedBiome;
        }
        
        colorBodyVertex(body, i);
        touchedAny = true;
      }
      if (touchedAny) commitBodyChanges(body);
    }

    // ---------- Terrain generation ----------
    // Seeded sum-of-random-plane-waves on the sphere. Each "octave" is a random unit
    // direction with its own frequency/phase; cos(dir · point) summed over many
    // octaves produces continent-like patterns without a full simplex impl.
    const TERRAIN_OCTAVES = 24;

    function hashSeed(str) {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 16777619);
      }
      return h >>> 0;
    }

    function makeRNG(seed) {
      let s = (seed | 0) || 1;
      return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function buildTerrainBasis(seedNum, count) {
      const rng = makeRNG(seedNum);
      const basis = [];
      let ampSum = 0;
      for (let k = 0; k < count; k++) {
        const a = rng() * Math.PI * 2;
        const z = rng() * 2 - 1;
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const freq = 0.6 + k * 0.35 + rng() * 0.25;
        const amp = 1 / (0.5 + freq * 0.8);
        ampSum += amp;
        basis.push({
          dx: r * Math.cos(a),
          dy: r * Math.sin(a),
          dz: z,
          freq,
          amp,
          phase: rng() * Math.PI * 2,
        });
      }
      for (const b of basis) b.amp /= ampSum;
      return basis;
    }

    function sampleTerrainNoise(basis, ux, uy, uz) {
      let sum = 0;
      for (let i = 0; i < basis.length; i++) {
        const b = basis[i];
        sum += Math.cos((b.dx * ux + b.dy * uy + b.dz * uz) * b.freq * Math.PI + b.phase) * b.amp;
      }
      return sum;
    }

    // amplitude: peak height in height-units. seaCoverage (0..1): fraction of surface
    // biased below sea level (by picking that percentile of samples as the new zero).
    const ARCHETYPES = {
      terrestrial: { name: 'Terrestrial', palette: PLANET_PALETTE, hasOcean: true, amp: 2.0, sea: 0.55 },
      ocean: { name: 'Ocean World', palette: { deep: 0x001a33, shore: 0x004d99, sand: 0x0066cc, grass: 0x0080ff, rock: 0x3399ff, snow: 0x66b2ff }, hasOcean: true, amp: 1.5, sea: 0.9 },
      gas_giant: { name: 'Gas Giant', palette: { deep: 0x331a00, shore: 0x663300, sand: 0x996633, grass: 0xcc9966, rock: 0xffcc99, snow: 0xffffff }, hasOcean: false, amp: 0.8, sea: 0.0 },
      ice_giant: { name: 'Ice Giant', palette: { deep: 0x003366, shore: 0x006699, sand: 0x3399ff, grass: 0x66b2ff, rock: 0x99ccff, snow: 0xffffff }, hasOcean: false, amp: 1.2, sea: 0.0 },
      desert: { name: 'Desert Planet', palette: { deep: 0x4d3319, shore: 0x805500, sand: 0xd2b48c, grass: 0xc2a679, rock: 0x8b4513, snow: 0xd2b48c }, hasOcean: false, amp: 2.5, sea: 0.0 },
      lava: { name: 'Lava Planet', palette: { deep: 0x330000, shore: 0x660000, sand: 0xff3300, grass: 0xff6600, rock: 0x331a00, snow: 0x663300 }, hasOcean: true, oceanCol: 0xff4500, amp: 3.0, sea: 0.4 },
      ice_planet: { name: 'Ice Planet', palette: { deep: 0x003366, shore: 0x006699, sand: 0x99ccff, grass: 0xccf2ff, rock: 0x6699cc, snow: 0xffffff }, hasOcean: false, amp: 1.8, sea: 0.0 },
      jungle: { name: 'Jungle Planet', palette: { deep: 0x002200, shore: 0x004400, sand: 0x1a3300, grass: 0x006400, rock: 0x2d5a27, snow: 0x4d994d }, hasOcean: true, oceanCol: 0x1a3300, amp: 2.5, sea: 0.4 },
      swamp: { name: 'Swamp Planet', palette: { deep: 0x1a1a00, shore: 0x333300, sand: 0x4d4d00, grass: 0x2d5a27, rock: 0x1a3300, snow: 0x4d994d }, hasOcean: true, oceanCol: 0x2d5a27, amp: 1.5, sea: 0.7 },
      toxic: { name: 'Toxic Planet', palette: { deep: 0x1a0033, shore: 0x330066, sand: 0xadff2f, grass: 0x32cd32, rock: 0x4b0082, snow: 0x7fff00 }, hasOcean: true, oceanCol: 0xadff2f, amp: 2.2, sea: 0.6 },
      venusian: { name: 'Venusian Planet', palette: { deep: 0x4a3520, shore: 0x7a5a2e, sand: 0xc9a25b, grass: 0xd2b074, rock: 0x8f6d3a, snow: 0xf2e2b5 }, hasOcean: false, amp: 1.5, sea: 0.0 },
      metal: { name: 'Metal-Rich', palette: { deep: 0x1a1a1a, shore: 0x333333, sand: 0x4d4d4d, grass: 0x666666, rock: 0x1a1a1a, snow: 0xffd700 }, hasOcean: false, amp: 3.5, sea: 0.0 },
      carbon: { name: 'Carbon Planet', palette: { deep: 0x050505, shore: 0x101010, sand: 0x1a1a1a, grass: 0x252525, rock: 0x0a0a0a, snow: 0x333333 }, hasOcean: false, amp: 2.2, sea: 0.0 },
      moon_like: { name: 'Moon-Like Rocky Planet', palette: { deep: 0x322e29, shore: 0x4a4238, sand: 0x6f6357, grass: 0x8a8174, rock: 0xa49a8b, snow: 0xe2dccf }, hasOcean: false, amp: 1.8, sea: 0.0 },
      storm: { name: 'Storm Planet', palette: { deep: 0x1a1a33, shore: 0x333366, sand: 0x4d4d99, grass: 0x6666cc, rock: 0x1a1a4d, snow: 0x9999ff }, hasOcean: true, oceanCol: 0x1a1a33, amp: 3.5, sea: 0.5 },
      living: { name: 'Living Planet', palette: { deep: 0x33001a, shore: 0x660033, sand: 0x99004d, grass: 0xcc0066, rock: 0x33001a, snow: 0xff0080 }, hasOcean: true, oceanCol: 0x4d0026, amp: 1.8, sea: 0.3 },
      rogue: { name: 'Rogue Planet', palette: { deep: 0x020205, shore: 0x050510, sand: 0x0a0a1a, grass: 0x101025, rock: 0x020208, snow: 0x1a1a33 }, hasOcean: false, amp: 2.0, sea: 0.0 },
    };

    // Each archetype declares its matter composition. `gas` is one of:
    //   false        — no gas at all (bare rock world)
    //   'atmosphere' — thin shell wrapping the solid/liquid surface
    //   'full'       — body IS the gas (no solid, no liquid; e.g. gas giants)
    // gasThickness is multiplied with baseRadius (1.0 = surface; 1.20 = +20%).
    // gasDensity is the shell's base opacity (0..1).
    const ARCHETYPE_MATTER = {
      terrestrial: { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xffffff, gasThickness: 1.10, gasDensity: 0.45, gasCoverage: 0.35 },
      ocean:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xcce7ff, gasThickness: 1.10, gasDensity: 0.50, gasCoverage: 0.40 },
      gas_giant:   { solid: false, liquid: false, gas: 'full',       gasCol: 0xc89060, gasThickness: 1.00, gasDensity: 0.95, gasCoverage: 0.50 },
      ice_giant:   { solid: false, liquid: false, gas: 'full',       gasCol: 0x88bbee, gasThickness: 1.00, gasDensity: 0.92, gasCoverage: 0.50 },
      desert:      { solid: true,  liquid: false, gas: false },
      lava:        { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xff8844, gasThickness: 1.08, gasDensity: 0.55, gasCoverage: 0.40 },
      ice_planet:  { solid: true,  liquid: false, gas: 'atmosphere', gasCol: 0xccddee, gasThickness: 1.05, gasDensity: 0.30, gasCoverage: 0.25 },
      jungle:      { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xe8f5e0, gasThickness: 1.12, gasDensity: 0.55, gasCoverage: 0.65 },
      swamp:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xc5d4a8, gasThickness: 1.10, gasDensity: 0.60, gasCoverage: 0.55 },
      toxic:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xadff2f, gasThickness: 1.15, gasDensity: 0.70, gasCoverage: 0.70 },
      venusian:    { solid: true,  liquid: false, gas: 'atmosphere', gasCol: 0xe6c870, gasThickness: 1.16, gasDensity: 1.00, gasCoverage: 1.00 },
      metal:       { solid: true,  liquid: false, gas: false },
      carbon:      { solid: true,  liquid: false, gas: 'atmosphere', gasCol: 0x555555, gasThickness: 1.06, gasDensity: 0.45, gasCoverage: 0.40 },
      moon_like:   { solid: true,  liquid: false, gas: false },
      storm:       { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xaaaaff, gasThickness: 1.18, gasDensity: 0.80, gasCoverage: 0.85 },
      living:      { solid: true,  liquid: true,  gas: 'atmosphere', gasCol: 0xff99cc, gasThickness: 1.08, gasDensity: 0.50, gasCoverage: 0.45 },
      rogue:       { solid: true,  liquid: false, gas: false },
    };

    let currentArchetype = 'terrestrial';

    // Apply an archetype's matter spec to a body: toggles solid/liquid/gas
    // meshes and tunes the gas shell. Pulled out of regenerateBody so the UI
    // (atmosphere sliders) can re-apply gas changes without re-running terrain.
    function applyMatterToBody(body, matterCfg, oceanCol) {
      body.matter = { solid: !!matterCfg.solid, liquid: !!matterCfg.liquid, gas: matterCfg.gas || false };
      body.mesh.visible = !!matterCfg.solid;

      if (body.oceanMesh) {
        body.oceanMesh.material.color.setHex(oceanCol || COL.water);
        body.oceanMesh.visible = !!matterCfg.liquid;
      }

      if (body.gasMesh) {
        if (matterCfg.gas) {
          body.gasMode = matterCfg.gas;
          // Take the archetype defaults on first apply; UI overrides persist
          // because applyGasShell reads body.gasThickness/Density/Coverage directly.
          body.gasThickness = matterCfg.gasThickness ?? 1.10;
          body.gasDensity   = matterCfg.gasDensity   ?? 0.20;
          body.gasCoverage  = matterCfg.gasCoverage  ?? 0.35;
          const u = body.gasMesh.material.uniforms;
          u.uColor.value.setHex(matterCfg.gasCol || 0xffffff);
          u.uMode.value = matterCfg.gas === 'full' ? 1.0 : 0.0;
          applyGasShell(body);
          body.gasMesh.visible = true;
        } else {
          body.gasMode = 'none';
          body.gasMesh.visible = false;
        }
      }
    }

    // Push gas mesh state from the body's fields. Separate so UI sliders can
    // mutate body fields and call this without going through the archetype path.
    function applyGasShell(body) {
      if (!body.gasMesh) return;
      body.gasMesh.scale.setScalar(body.gasThickness || 1.0);
      const u = body.gasMesh.material.uniforms;
      u.uDensity.value  = Math.max(0, Math.min(1, body.gasDensity  ?? 0.2));
      u.uCoverage.value = Math.max(0, Math.min(1, body.gasCoverage ?? 0.35));
    }

    // Push ring state from body.rings into the ringMesh. Visibility + intensity
    // are the only knobs; geometry is fixed at create time because RING_*_FACTOR
    // are baked into the buffer.
    function applyRingsToBody(body) {
      if (!body.ringMesh) return;
      const r = body.rings || (body.rings = { enabled: false, intensity: 0.65 });
      body.ringMesh.visible = !!r.enabled;
      body.ringMesh.material.uniforms.uIntensity.value =
        Math.max(0, Math.min(1, r.intensity ?? 0.65));
    }

    function regenerateBody(body, seedStr, amplitude, seaCoverage) {
      const arch = ARCHETYPES[currentArchetype] || ARCHETYPES.terrestrial;
      // Only planets adopt the archetype's palette + matter — moons keep their
      // fixed grayscale palette and stay solid-only (the global `currentArchetype`
      // belongs to whichever planet the UI is editing).
      if (body.kind === 'planet') {
        body.palette = arch.palette;
        const matterCfg = ARCHETYPE_MATTER[currentArchetype] || ARCHETYPE_MATTER.terrestrial;
        applyMatterToBody(body, matterCfg, arch.oceanCol);
      }

      const basis = buildTerrainBasis(hashSeed(seedStr), TERRAIN_OCTAVES);
      const samples = new Float32Array(body.N);
      for (let i = 0; i < body.N; i++) {
        samples[i] = sampleTerrainNoise(basis, body.unitDirs[3 * i], body.unitDirs[3 * i + 1], body.unitDirs[3 * i + 2]);
      }
      const sorted = Float32Array.from(samples).sort();
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * seaCoverage)));
      const bias = sorted[idx];
      for (let i = 0; i < body.N; i++) {
        const h = (samples[i] - bias) * amplitude;
        body.heights[i] = h < MIN_LAND_HEIGHT ? MIN_LAND_HEIGHT
                        : h > MAX_LAND_HEIGHT ? MAX_LAND_HEIGHT
                        : h;
        // Reset biomes on regen
        body.biomes[i] = BIOME.AUTO;
        writeBodyVertex(body, i);
        colorBodyVertex(body, i);
      }
      commitBodyChanges(body);
    }

    // ---------- Planets (orbiting the sun) ----------
    // planets[] holds each planet body + its orbit. Orbit angle ticks in the
    // animate loop. The first entry is also exposed as `planet` for back-compat
    // with code that was written when there was only one.
    const planets = [];

    // Per-planet spin rate (rad/s). Declared here — not next to
    // updatePlanetRotation — so registerPlanet() can reference it at init time
    // when the first planets are wired up.
    const DEFAULT_SPIN = (30 / 3000) * Math.PI * 2;

    function updatePlanetOrbitPosition(p) {
      const o = p.orbit;
      const x = Math.cos(o.angle) * o.distance;
      const z0 = Math.sin(o.angle) * o.distance;
      const inc = o.inclination || 0;
      const ci = Math.cos(inc), si = Math.sin(inc);
      p.body.group.position.set(x, -z0 * si, z0 * ci);
    }

    function updatePlanetOrbits(dt) {
      for (const p of planets) {
        p.orbit.angle += p.orbit.speed * dt;
        updatePlanetOrbitPosition(p);
      }
    }

    function registerPlanet(body, archetype, seedStr, orbit) {
      body.archetype = archetype;
      body.currentSeed = seedStr;
      if (body.rotationSpeed == null) body.rotationSpeed = DEFAULT_SPIN;
      const entry = { body, orbit: { ...orbit } };
      planets.push(entry);
      updatePlanetOrbitPosition(entry);
      refreshOrbitLine(entry);
      return entry;
    }

    // ---------- Orbit ellipse trajectories ----------
    // A thin LineLoop traces each planet's path around the sun. We keep them
    // all in one group so a single visible flag toggles every line at once.
    // Moons orbit their parent planet (not the sun) and the parent itself is
    // moving, so a static line wouldn't track them — those are skipped.
    const ORBIT_LINE_SEGMENTS = 192;
    const orbitLinesGroup = new THREE.Group();
    scene.add(orbitLinesGroup);

    function buildOrbitLineGeometry(distance, inclination) {
      const pts = new Float32Array(ORBIT_LINE_SEGMENTS * 3);
      const ci = Math.cos(inclination || 0);
      const si = Math.sin(inclination || 0);
      for (let i = 0; i < ORBIT_LINE_SEGMENTS; i++) {
        const t = (i / ORBIT_LINE_SEGMENTS) * Math.PI * 2;
        const x  = Math.cos(t) * distance;
        const z0 = Math.sin(t) * distance;
        pts[3 * i]     = x;
        pts[3 * i + 1] = -z0 * si;
        pts[3 * i + 2] = z0 * ci;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      return geo;
    }

    function refreshOrbitLine(entry) {
      const { distance, inclination } = entry.orbit;
      if (!entry.orbitLine) {
        const geo = buildOrbitLineGeometry(distance, inclination);
        const mat = new THREE.LineBasicMaterial({
          color: 0x00f2ff,
          transparent: true,
          opacity: 0.32,
          depthWrite: false,
        });
        entry.orbitLine = new THREE.LineLoop(geo, mat);
        orbitLinesGroup.add(entry.orbitLine);
      } else {
        entry.orbitLine.geometry.dispose();
        entry.orbitLine.geometry = buildOrbitLineGeometry(distance, inclination);
      }
    }

    function disposeOrbitLine(entry) {
      if (!entry.orbitLine) return;
      orbitLinesGroup.remove(entry.orbitLine);
      entry.orbitLine.geometry.dispose();
      entry.orbitLine.material.dispose();
      entry.orbitLine = null;
    }

    // --- Solar system bootstrap ---
    // Sizes/distances/speeds are visually scaled — not astronomically accurate.
    // Order is preserved (inner planets close + fast, gas giants huge + slow)
    // and the speeds roughly follow Kepler's third law (ω ∝ 1/a^1.5) so the
    // outer planets crawl while the inner ones whip around.
    const SOLAR_SYSTEM_SPEC = [
      { name: 'Mercury', archetype: 'moon_like',   size: 0.25, distance:  60, speed: 0.35,  inclination:  0.06, angle: 0.20, seed: 'mercury', moons: [] },
      { name: 'Venus',   archetype: 'venusian',    size: 0.40, distance:  95, speed: 0.25,  inclination: -0.05, angle: 1.10, seed: 'venus',   moons: [] },
      { name: 'Earth',   archetype: 'terrestrial', size: 0.45, distance: 135, speed: 0.18,  inclination:  0.03, angle: 2.10, seed: 'earth',
        moons: [ { name: 'Moon', size: 0.30, distance: 10, seed: 'luna' } ] },
      { name: 'Mars',    archetype: 'desert',      size: 0.32, distance: 180, speed: 0.13,  inclination: -0.08, angle: 3.20, seed: 'mars',    moons: [] },
      { name: 'Jupiter', archetype: 'gas_giant',   size: 1.20, distance: 260, speed: 0.07,  inclination:  0.02, angle: 4.30, seed: 'jupiter',
        moons: [
          { name: 'Io',       size: 0.30, distance: 22, seed: 'io' },
          { name: 'Europa',   size: 0.28, distance: 28, seed: 'europa' },
          { name: 'Ganymede', size: 0.42, distance: 34, seed: 'ganymede' },
          { name: 'Callisto', size: 0.38, distance: 42, seed: 'callisto' },
        ] },
      { name: 'Saturn',  archetype: 'gas_giant',   size: 1.05, distance: 360, speed: 0.05,  inclination: -0.04, angle: 5.10, seed: 'saturn',
        rings: { enabled: true, intensity: 0.80 },
        moons: [ { name: 'Titan', size: 0.45, distance: 24, seed: 'titan' } ] },
      { name: 'Uranus',  archetype: 'ice_giant',   size: 0.75, distance: 460, speed: 0.035, inclination:  0.08, angle: 0.60, seed: 'uranus',  moons: [] },
      { name: 'Neptune', archetype: 'ice_giant',   size: 0.72, distance: 560, speed: 0.025, inclination: -0.06, angle: 5.80, seed: 'neptune', moons: [] },
    ];

    function spawnSolarPlanet(spec) {
      const arch = ARCHETYPES[spec.archetype];
      const body = createBody({
        kind: 'planet',
        name: spec.name,
        baseRadius: BASE_RADIUS,
        detail: ICO_DETAIL,
        hasOcean: arch.hasOcean,
      });
      bodies.push(body);
      scene.add(body.group);
      body.group.scale.setScalar(spec.size);
      // regenerateBody reads currentArchetype off the module scope; flip it
      // briefly so the correct palette/matter is applied without disturbing UI.
      const prev = currentArchetype;
      currentArchetype = spec.archetype;
      regenerateBody(body, spec.seed, arch.amp, arch.sea);
      currentArchetype = prev;
      body.currentAmp = arch.amp;
      body.currentSea = arch.sea;
      registerPlanet(body, spec.archetype, spec.seed, {
        angle: spec.angle,
        distance: spec.distance,
        speed: spec.speed,
        inclination: spec.inclination,
      });
      if (spec.rings) {
        body.rings.enabled   = spec.rings.enabled ?? true;
        body.rings.intensity = spec.rings.intensity ?? 0.65;
        applyRingsToBody(body);
      }
      return body;
    }

    const solarBodies = SOLAR_SYSTEM_SPEC.map(spawnSolarPlanet);
    // Earth is the conventional "home" — keep the `planet` alias pointing at
    // it so older code that grabs the canonical first planet still works.
    const planet = solarBodies[2];

    // ---------- Brush ----------
    let brushRadius   = 0.25; // radians of arc on the unit sphere
    let brushStrength = 1.5;  // height units per second of holding
    let brushRaise    = true; // false = lower
    let paintMode     = true; // when true, right-drag paints; when false, right-drag pans
    let paused        = false;
    let currentTool   = 'land'; // 'land' or 'biome'
    let selectedBiome = BIOME.AUTO;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let isPainting = false;
    let activeBrushBody = null;  // body the current drag stroke is editing
    let lastHitLocal = null;     // hit point in activeBrushBody's mesh-local space

    // Brush cursor — a thin ring oriented to the surface tangent plane.
    const brushRingGeo = new THREE.RingGeometry(0.95, 1.0, 64);
    const brushRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
    });
    const brushRing = new THREE.Mesh(brushRingGeo, brushRingMat);
    brushRing.renderOrder = 999;
    brushRing.visible = false;
    scene.add(brushRing);

    function updateBrushRing(hitWorld, hitNormalWorld, radiusWorld) {
      brushRing.position.copy(hitWorld);
      brushRing.lookAt(hitWorld.clone().add(hitNormalWorld));
      brushRing.position.addScaledVector(hitNormalWorld, 0.02);
      brushRing.scale.setScalar(radiusWorld);
      brushRing.visible = true;
    }

    // arcLen ≈ angularRadius * R, where R is the radial distance at the hit.
    function brushArcWorldRadius(hitRadius) {
      return brushRadius * hitRadius;
    }

    // ---------- Pointer handling ----------
    function setPointerFromEvent(e) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    }

    // Raycast against every body's mesh; return { hit, body } for the closest one.
    function raycastBodies() {
      raycaster.setFromCamera(pointer, camera);
      // Filter out invisible solid meshes (e.g. gas giants where matter.solid is
      // false). Three.js' raycaster ignores `visible` by default, so without
      // this filter the brush would hit empty space on gas worlds.
      const meshes = bodies.filter(b => b.mesh.visible).map(b => b.mesh);
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits.length === 0) return null;
      const hit = hits[0];
      const body = bodies.find(b => b.mesh === hit.object) || null;
      if (!body) return null;
      return { hit, body };
    }

    function worldToBodyLocal(body, worldPoint) {
      return body.mesh.worldToLocal(worldPoint.clone());
    }

    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (e.button !== 2) return;
      if (!paintMode) return;
      e.preventDefault();
      setPointerFromEvent(e);
      const hb = raycastBodies();
      if (!hb) return;

      if (currentTool === 'city') {
        const name = cityNameInput.value || 'New City';
        const localPos = worldToBodyLocal(hb.body, hb.hit.point);
        addCity(hb.body, name, localPos);
      } else {
        isPainting = true;
        activeBrushBody = hb.body;
        lastHitLocal = worldToBodyLocal(hb.body, hb.hit.point);
        renderer.domElement.setPointerCapture(e.pointerId);
      }
    });

    renderer.domElement.addEventListener('pointermove', (e) => {
      setPointerFromEvent(e);
      // City tool drops a single marker on click — no brush footprint to preview.
      if (!paintMode || currentTool === 'city') {
        brushRing.visible = false;
        return;
      }
      const hb = raycastBodies();
      if (!hb) {
        brushRing.visible = false;
        if (isPainting) lastHitLocal = null;
        return;
      }
      const nWorld = hb.hit.face.normal.clone()
        .transformDirection(hb.body.mesh.matrixWorld)
        .normalize();
      // Scale the ring by the body's local hit radius times its world scale so the
      // visible ring matches the brush footprint on bodies of any size.
      const worldScale = hb.body.group.scale.x;
      const localHitRadius = worldToBodyLocal(hb.body, hb.hit.point).length();
      updateBrushRing(hb.hit.point, nWorld, brushArcWorldRadius(localHitRadius) * worldScale);
      if (isPainting) {
        // Only continue painting on the body we started on, so dragging off doesn't
        // jump the brush to a different body.
        if (hb.body === activeBrushBody) lastHitLocal = worldToBodyLocal(hb.body, hb.hit.point);
        else lastHitLocal = null;
      }
    });

    function endPaint(e) {
      if (!isPainting) return;
      isPainting = false;
      lastHitLocal = null;
      activeBrushBody = null;
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
      updateInfoPanel();
    }
    renderer.domElement.addEventListener('pointerup', endPaint);
    renderer.domElement.addEventListener('pointercancel', endPaint);

    // Suppress the browser context menu over the canvas while paint mode is on.
    renderer.domElement.addEventListener('contextmenu', (e) => {
      if (paintMode) e.preventDefault();
    });

    // ---------- Moons (each is a full editable body) ----------
    // Moons are built once at MOON_BASE_RADIUS = 1 and resized via group.scale,
    // so the slider can change apparent size without rebuilding geometry.
    const MOON_BASE_RADIUS = 1;
    const MOON_DETAIL = 4;            // ~1280 verts; smaller bodies don't need planet-level density
    const MAX_MOONS = 4;              // per parent planet
    const MOON_REF_DISTANCE = 22;
    let moonSpeedScalar = (40 / 3000) * Math.PI * 2;
    let moonSeedCounter = 0;          // ensures each new moon gets a distinct seed
    const moons = [];
    // Slot tracking is per-parent so each planet has its own 0..MAX_MOONS slots.
    const moonSlotsByParent = new Map();

    function moonOrbitPlane(slot) {
      return {
        inclination: (slot % 2 === 0 ? 1 : -1) * (0.08 + 0.18 * slot),
        node: slot * 1.1,
        phase: (slot / MAX_MOONS) * Math.PI * 2,
      };
    }

    function allocateMoonSlot(parent) {
      let used = moonSlotsByParent.get(parent);
      if (!used) { used = new Set(); moonSlotsByParent.set(parent, used); }
      for (let i = 0; i < MAX_MOONS; i++) {
        if (!used.has(i)) { used.add(i); return i; }
      }
      return -1;
    }

    function freeMoonSlot(parent, slot) {
      const used = moonSlotsByParent.get(parent);
      if (used) used.delete(slot);
    }

    function updateMoonPosition(m) {
      const x0 = Math.cos(m.angle) * m.distance;
      const z0 = Math.sin(m.angle) * m.distance;
      const ci = Math.cos(m.inclination), si = Math.sin(m.inclination);
      const y1 = -z0 * si;
      const z1 = z0 * ci;
      const cn = Math.cos(m.node), sn = Math.sin(m.node);
      const xf = x0 * cn - z1 * sn;
      const zf = x0 * sn + z1 * cn;
      // Position is parent-relative — moons follow their planet through its
      // solar orbit without being parented as scene-graph children (which would
      // also pick up the planet's day rotation, which we don't want).
      const pp = m.parent ? m.parent.group.position : { x: 0, y: 0, z: 0 };
      m.body.group.position.set(xf + pp.x, y1 + pp.y, zf + pp.z);
    }

    function addMoon(parent, size, distance, opts = {}) {
      const host = parent || planet;
      const ownCount = moons.reduce((n, m) => n + (m.parent === host ? 1 : 0), 0);
      if (ownCount >= MAX_MOONS) return null;
      const slot = allocateMoonSlot(host);
      if (slot < 0) return null;
      const plane = moonOrbitPlane(slot);
      const seed = opts.seed || ('moon-' + (++moonSeedCounter));
      const name = opts.name || `${host.name} · Moon ${ownCount + 1}`;
      const body = createBody({
        kind: 'moon',
        name,
        baseRadius: MOON_BASE_RADIUS,
        detail: MOON_DETAIL,
        hasOcean: false,
      });
      body.group.scale.setScalar(size);
      regenerateBody(body, seed, 1.6, 0.0); // moons start fully above "sea" — no ocean
      scene.add(body.group);
      bodies.push(body);
      const moon = {
        body,
        parent: host,
        seed,
        angle: plane.phase,
        inclination: plane.inclination,
        node: plane.node,
        size,
        distance,
        slot,
      };
      moons.push(moon);
      updateMoonPosition(moon);
      return moon;
    }

    function removeMoonAt(index) {
      const moon = moons[index];
      if (!moon) return;
      if (focusedBody === moon.body) setFocus(moon.parent || planet);
      scene.remove(moon.body.group);
      const bi = bodies.indexOf(moon.body);
      if (bi >= 0) bodies.splice(bi, 1);
      moon.body.geo.dispose();
      moon.body.mesh.material.dispose();
      freeMoonSlot(moon.parent, moon.slot);
      moons.splice(index, 1);
      updateInfoPanel();
    }

    function setMoonSize(index, size) {
      const m = moons[index];
      if (!m) return;
      m.size = size;
      m.body.group.scale.setScalar(size);
    }

    function setMoonDistance(index, distance) {
      const m = moons[index];
      if (!m) return;
      m.distance = distance;
      updateMoonPosition(m);
    }

    function updateMoons(dt) {
      for (const m of moons) {
        const omega = moonSpeedScalar * Math.pow(MOON_REF_DISTANCE / m.distance, 1.5);
        m.angle += omega * dt;
        updateMoonPosition(m);
      }
    }

    const cities = [];

    function addCity(body, name, localPos) {
      const city = {
        body,
        name,
        localPos: localPos.clone().normalize(),
        mesh: createCityMarker(),
      };
      body.group.add(city.mesh);
      cities.push(city);
      updateCityMarkers();
      renderCityList();
    }

    function createCityMarker() {
      // Small glowing cube or pyramid
      const geo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
      const mat = new THREE.MeshBasicMaterial({ color: COL.cityLights });
      return new THREE.Mesh(geo, mat);
    }

    function updateCityMarkers() {
      const sunWorld = new THREE.Vector3();
      sunMesh.getWorldPosition(sunWorld);
      const planetCenter = new THREE.Vector3();
      const cityWorld = new THREE.Vector3();
      cities.forEach(city => {
        const body = city.body;
        const r = body.baseRadius + 0.1;
        city.mesh.position.copy(city.localPos).multiplyScalar(r);
        city.mesh.lookAt(new THREE.Vector3(0, 0, 0));

        // Day/night relative to *this* planet's sun direction (matters now that
        // planets orbit — direction from planet center to sun varies).
        city.mesh.getWorldPosition(cityWorld);
        body.group.getWorldPosition(planetCenter);
        const toSun = sunWorld.clone().sub(planetCenter).normalize();
        const surfaceNormal = cityWorld.clone().sub(planetCenter).normalize();
        const dot = surfaceNormal.dot(toSun);
        city.mesh.material.opacity = dot < 0.1 ? 1.0 : 0.2;
        city.mesh.material.transparent = true;
      });
    }

    function renderCityList() {
      const list = document.getElementById('cityList');
      list.innerHTML = cities.map((c, i) => {
        const focusedCls = focusedCity === c ? ' focused' : '';
        return `
        <div class="city-row" data-index="${i}">
          <span>${c.name} (${c.body.name})</span>
          <button class="city-focus focus-btn small-btn${focusedCls}" type="button">Focus</button>
          <button class="city-remove" type="button" aria-label="Remove city">×</button>
        </div>`;
      }).join('');
      list.querySelectorAll('.city-row').forEach((row) => {
        const index = parseInt(row.dataset.index, 10);
        row.querySelector('.city-focus').onclick = () => {
          const c = cities[index];
          if (c) setCityFocus(c);
        };
        row.querySelector('.city-remove').onclick = () => removeCityAt(index);
      });
    }

    function removeCityAt(index) {
      const city = cities[index];
      if (!city) return;
      if (focusedCity === city) {
        focusedCity = null;
        focusNameEl.textContent = focusedBody ? focusedBody.name : '';
      }
      city.body.group.remove(city.mesh);
      cities.splice(index, 1);
      renderCityList();
    }
    // Kept for backwards-compat with any inline onclick already in the DOM.
    window.removeCity = removeCityAt;
    const starCount = 2000;
    const starPositions = new Float32Array(starCount * 3);
    // Stars sit at a large radius so they read as a backdrop even when the
    // system-view camera is pulled out hundreds of units to frame all planets.
    for (let i = 0; i < starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 2200;
      starPositions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPositions[i * 3 + 2] = r * Math.cos(phi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: false,
    });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // ---------- Planet rotation ----------
    // Each planet carries its own spin rate (rad/s) so the System tab's Spin
    // slider can tune them independently. registerPlanet() seeds new bodies
    // with DEFAULT_SPIN (declared earlier, alongside the planets[] array, so
    // it's available when the first planets register at module init time).
    function updatePlanetRotation(dt) {
      for (const p of planets) {
        const w = p.body.rotationSpeed ?? DEFAULT_SPIN;
        p.body.group.rotation.y += w * dt;
      }
    }

    // PointLight sits at the sun's origin, so its lighting direction is
    // already correct per-body (each fragment computes its own light vector).
    // The atmosphere shader still uses a uniform vec3 uSunDir, so we refresh
    // each body's gas material with its own (body → sun) direction.
    const _sunWorldTmp = new THREE.Vector3();
    const _bodyPosTmp  = new THREE.Vector3();
    const _toSunTmp    = new THREE.Vector3();
    function updateSunLightForFocus() {
      sunMesh.getWorldPosition(_sunWorldTmp);
      for (const b of bodies) {
        const needsGas  = !!(b.gasMesh  && b.gasMesh.material.uniforms.uSunDir);
        const needsRing = !!(b.ringMesh && b.ringMesh.visible);
        if (!needsGas && !needsRing) continue;
        b.group.getWorldPosition(_bodyPosTmp);
        _toSunTmp.subVectors(_sunWorldTmp, _bodyPosTmp);
        if (_toSunTmp.lengthSq() < 1e-8) _toSunTmp.set(1, 0, 0);
        else _toSunTmp.normalize();
        if (needsGas) {
          b.gasMesh.material.uniforms.uSunDir.value.copy(_toSunTmp);
        }
        if (needsRing) {
          const u = b.ringMesh.material.uniforms;
          u.uSunDir.value.copy(_toSunTmp);
          u.uBodyCenter.value.copy(_bodyPosTmp);
          // World radius includes the body group's scale so the planet shadow
          // on the ring tracks visually no matter the planet size.
          u.uBodyRadius.value = b.baseRadius * b.group.scale.x;
        }
      }
    }

    // ---------- Focus ----------
    // Camera target each frame is either the focused body's center, or — if a city
    // is selected — that city marker's world position (still parented to its body,
    // so rotation/orbit naturally carries the target along).
    let focusedBody = planet;
    let focusedCity = null;

    function setFocus(body) {
      focusedBody = body;
      focusedCity = null;
      focusNameEl.textContent = body.name;
      const newTarget = new THREE.Vector3();
      body.group.getWorldPosition(newTarget);
      const effRadius = body.baseRadius * body.group.scale.x;
      const desiredDist = Math.max(effRadius * 3.2, effRadius + 4);
      let dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, 1);
      dir.normalize();
      camera.position.copy(newTarget).addScaledVector(dir, desiredDist);
      controls.target.copy(newTarget);
      renderFocusBadges();
      updateBiomeTools();
      updateInfoPanel();
      if (typeof applyFocusToLeftPanel === 'function') applyFocusToLeftPanel();
    }

    function setCityFocus(city) {
      focusedBody = city.body;
      focusedCity = city;
      focusNameEl.textContent = `${city.name} · ${city.body.name}`;
      const newTarget = new THREE.Vector3();
      city.mesh.getWorldPosition(newTarget);
      // Closer framing than a whole-body focus — settlement is a point, not a sphere.
      const effRadius = city.body.baseRadius * city.body.group.scale.x;
      const desiredDist = Math.max(effRadius * 1.2, effRadius + 2);
      // Look at the city from "above" the local surface: prefer the surface normal
      // direction so the city sits centered with the body curving away.
      const normal = newTarget.clone().sub(city.body.group.getWorldPosition(new THREE.Vector3())).normalize();
      if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0);
      camera.position.copy(newTarget).addScaledVector(normal, desiredDist);
      controls.target.copy(newTarget);
      renderFocusBadges();
      renderCityList();
      updateBiomeTools();
      updateInfoPanel();
      if (typeof applyFocusToLeftPanel === 'function') applyFocusToLeftPanel();
    }

    function updateFocusTracking() {
      if (!focusedBody) return;
      const newTarget = new THREE.Vector3();
      if (focusedCity) focusedCity.mesh.getWorldPosition(newTarget);
      else focusedBody.group.getWorldPosition(newTarget);
      const delta = newTarget.clone().sub(controls.target);
      if (delta.lengthSq() > 1e-12) {
        controls.target.copy(newTarget);
        // Keep camera offset relative to target so user-controlled orbit/zoom is preserved.
        camera.position.add(delta);
      }
    }

    // ---------- Info panel ----------
    let planetCurrentSeed = 'planet';

    // Category metadata: label + swatch color (matches the in-world palette). Covers
    // both "auto" (height-band) and biome-painted categories for planets and moons.
    const COMP_DISPLAY = {
      water:     { label: 'Water',       color: '#3FA1DC' },
      sand:      { label: 'Sand',        color: '#EDDFB8' },
      grass:     { label: 'Grass',       color: '#4FAE4F' },
      rock:      { label: 'Rock',        color: '#7d6a5a' },
      snow:      { label: 'Snow',        color: '#f0f4f8' },
      forest:    { label: 'Forest',      color: '#1a4d1a' },
      desert:    { label: 'Desert',      color: '#d2b48c' },
      city:      { label: 'Settlements', color: '#808080' },
      tundra:    { label: 'Tundra',      color: '#dde4ec' },
      crater:    { label: 'Crater',      color: '#322e29' },
      dust:      { label: 'Dust',        color: '#6f6357' },
      highlight: { label: 'Highlights',  color: '#e2dccf' },
      mare:      { label: 'Mare',        color: '#2a2a30' },
      regolith:  { label: 'Regolith',    color: '#c4b8a0' },
      frost:     { label: 'Frost',       color: '#d8e8f0' },
    };
    const PLANET_COMP_ORDER = ['water', 'sand', 'grass', 'forest', 'desert', 'rock', 'snow', 'tundra', 'city'];
    const MOON_COMP_ORDER   = ['crater', 'dust', 'rock', 'highlight', 'mare', 'regolith', 'frost', 'city'];

    // Per-archetype labels for the auto-painted height bands. Without these, a
    // desert planet reports "Grass" for its mid-elevation band even though that
    // band is colored desert-tan — confusing because no green is visible.
    const BAND_KEY_TO_PALETTE = { water: 'deep', sand: 'sand', grass: 'grass', rock: 'rock', snow: 'snow' };
    const ARCHETYPE_BAND_LABELS = {
      terrestrial: { water: 'Ocean',      sand: 'Coast',      grass: 'Grass',      rock: 'Rock',       snow: 'Snow' },
      ocean:       { water: 'Abyss',      sand: 'Deep',       grass: 'Sea',        rock: 'Shoal',      snow: 'Foam' },
      gas_giant:   { water: 'Deep Band',  sand: 'Lower Cloud',grass: 'Mid Cloud',  rock: 'Storm Belt', snow: 'High Cloud' },
      ice_giant:   { water: 'Deep Ice',   sand: 'Ice Shelf',  grass: 'Ice Plain',  rock: 'Ridge',      snow: 'Frost Crown' },
      desert:      { water: 'Basin',      sand: 'Dunes',      grass: 'Flats',      rock: 'Mesa',       snow: 'Salt Peak' },
      lava:        { water: 'Magma',      sand: 'Cinder',     grass: 'Lava Plain', rock: 'Basalt',     snow: 'Ash' },
      ice_planet:  { water: 'Subglacial', sand: 'Snowfield',  grass: 'Pack Ice',   rock: 'Glacier',    snow: 'Ice Peak' },
      jungle:      { water: 'River',      sand: 'Bank',       grass: 'Jungle',     rock: 'Highland',   snow: 'Canopy' },
      swamp:       { water: 'Bog',        sand: 'Marsh',      grass: 'Mossland',   rock: 'Ridge',      snow: 'Mist' },
      toxic:       { water: 'Acid Sea',   sand: 'Sludge',     grass: 'Bloom',      rock: 'Spire',      snow: 'Vapor' },
      venusian:    { water: 'Lava Plain', sand: 'Ochre Flat', grass: 'Cream Crust',rock: 'Basalt',     snow: 'Highland' },
      metal:       { water: 'Slag Pit',   sand: 'Plate',      grass: 'Sheet',      rock: 'Ridge',      snow: 'Vein' },
      carbon:      { water: 'Tar',        sand: 'Ash Flat',   grass: 'Soot Plain', rock: 'Diamond',    snow: 'Carbon Peak' },
      moon_like:   { water: 'Crater Floor',sand: 'Dust Plain', grass: 'Regolith',   rock: 'Highland',   snow: 'Frost Cap' },
      storm:       { water: 'Squall Sea', sand: 'Foam',       grass: 'Plain',      rock: 'Ridge',      snow: 'Cyclone' },
      living:      { water: 'Blood Sea',  sand: 'Vein',       grass: 'Flesh',      rock: 'Bone',       snow: 'Organ' },
      rogue:       { water: 'Void',       sand: 'Dust',       grass: 'Plain',      rock: 'Ridge',      snow: 'Peak' },
    };

    function hexFromNumber(n) {
      return '#' + (n >>> 0).toString(16).padStart(6, '0');
    }

    // Build the (label, swatch-color) pair for a planet band, using the planet's
    // actual palette so the swatch matches what's drawn on the surface.
    function bandMeta(body, key) {
      const arch = body.archetype || 'terrestrial';
      const labels = ARCHETYPE_BAND_LABELS[arch] || ARCHETYPE_BAND_LABELS.terrestrial;
      const label = labels[key] || COMP_DISPLAY[key].label;
      let color;
      if (key === 'water' && body.oceanMesh && body.oceanMesh.visible) {
        color = '#' + body.oceanMesh.material.color.getHexString();
      } else {
        const palKey = BAND_KEY_TO_PALETTE[key];
        color = body.palette && body.palette[palKey] != null
          ? hexFromNumber(body.palette[palKey])
          : COMP_DISPLAY[key].color;
      }
      return { label, color };
    }

    function computeBodyStats(body) {
      let peak = -Infinity;
      const counts = {};
      const hasBiomes = body.biomes != null;
      for (let i = 0; i < body.N; i++) {
        const h = body.heights[i];
        if (h > peak) peak = h;
        const b = hasBiomes ? body.biomes[i] : 0;
        let key;
        if (b === 1) key = 'forest';
        else if (b === 2) key = 'desert';
        else if (b === 3) key = 'city';
        else if (b === 4) key = 'tundra';
        else if (b === BIOME.MARE) key = 'mare';
        else if (b === BIOME.REGOLITH) key = 'regolith';
        else if (b === BIOME.FROST) key = 'frost';
        else if (body.kind === 'planet') {
          if (h < SEA_LEVEL) key = 'water';
          else if (h < SAND_TOP) key = 'sand';
          else if (h < GRASS_TOP) key = 'grass';
          else if (h < ROCK_TOP) key = 'rock';
          else key = 'snow';
        } else {
          if (h < 0) key = 'crater';
          else if (h < GRASS_TOP) key = 'dust';
          else if (h < ROCK_TOP) key = 'rock';
          else key = 'highlight';
        }
        counts[key] = (counts[key] || 0) + 1;
      }
      return { peak: peak === -Infinity ? 0 : peak, N: body.N, counts };
    }

    function fmtPct(n, total) {
      if (!total) return '0%';
      const p = (n / total) * 100;
      return (p >= 10 ? p.toFixed(0) : p.toFixed(1)) + '%';
    }

    function fmtSeconds(s) {
      if (!isFinite(s)) return '∞';
      if (s < 60) return s.toFixed(1) + 's';
      const m = Math.floor(s / 60);
      const r = Math.round(s - m * 60);
      return `${m}m ${r}s`;
    }

    function peakWorldHeight(body, peak) {
      return body.baseRadius * Math.max(0, peak) * BODY_HEIGHT_SCALE * body.group.scale.x;
    }

    const infoEls = {
      name:         document.getElementById('infoBodyName'),
      subtitle:     document.getElementById('infoSubtitle'),
      composition:  document.getElementById('infoComposition'),
      peak:         document.getElementById('infoPeak'),
      verts:        document.getElementById('infoVerts'),
      moonsRow:     document.getElementById('infoMoonsRow'),
      moons:        document.getElementById('infoMoons'),
      timeSection:  document.getElementById('infoTimeSection'),
      dayPeriod:    document.getElementById('infoDayPeriod'),
      dayTime:      document.getElementById('infoDayTime'),
      orbitSection: document.getElementById('infoOrbitSection'),
      orbitDist:    document.getElementById('infoOrbitDist'),
      orbitOmega:   document.getElementById('infoOrbitOmega'),
      orbitPeriod:  document.getElementById('infoOrbitPeriod'),
      moonSize:     document.getElementById('infoMoonSize'),
    };

    function updateInfoPanel() {
      if (!infoEls.name) return; // info panel removed from HTML — nothing to update
      if (!focusedBody) {
        // System view — no specific body in focus.
        infoEls.name.textContent = `${systemName} System`;
        infoEls.subtitle.textContent = `${planets.length} planet${planets.length === 1 ? '' : 's'} · ${moons.length} satellite${moons.length === 1 ? '' : 's'}`;
        infoEls.composition.innerHTML = '<div class="info-row"><span>System overview</span></div>';
        infoEls.peak.textContent = '—';
        infoEls.verts.textContent = '—';
        infoEls.moonsRow.style.display = '';
        infoEls.moons.textContent = moons.length;
        infoEls.timeSection.style.display = 'none';
        infoEls.orbitSection.style.display = 'none';
        return;
      }
      const body = focusedBody;
      infoEls.name.textContent = body.name;
      const seed = body.kind === 'planet'
        ? (body.currentSeed || planetCurrentSeed)
        : (moons.find(m => m.body === body)?.seed || '');
      infoEls.subtitle.textContent = (body.kind === 'planet' ? 'Planet' : 'Moon') + (seed ? ` · seed "${seed}"` : '');

      const stats = computeBodyStats(body);
      const order = body.kind === 'planet' ? PLANET_COMP_ORDER : MOON_COMP_ORDER;
      const rows = [];
      for (const key of order) {
        const count = stats.counts[key] || 0;
        if (count === 0) continue;
        const meta = body.kind === 'planet' && key in BAND_KEY_TO_PALETTE
          ? bandMeta(body, key)
          : COMP_DISPLAY[key];
        rows.push(
          `<div class="comp-row">` +
          `<span class="comp-swatch" style="background:${meta.color}"></span>` +
          `<span>${meta.label}</span>` +
          `<span class="comp-pct">${fmtPct(count, stats.N)}</span>` +
          `</div>`
        );
      }
      infoEls.composition.innerHTML = rows.join('') || '<div class="info-row"><span>—</span></div>';

      const worldPeak = peakWorldHeight(body, stats.peak);
      const pctOfRadius = stats.peak * BODY_HEIGHT_SCALE * 100;
      infoEls.peak.textContent = `${worldPeak.toFixed(2)} u (${pctOfRadius.toFixed(1)}%)`;
      infoEls.verts.textContent = stats.N.toLocaleString();

      const isPlanet = body.kind === 'planet';
      infoEls.moonsRow.style.display = isPlanet ? '' : 'none';
      if (isPlanet) infoEls.moons.textContent = moons.length;
      infoEls.timeSection.style.display = isPlanet ? '' : 'none';
      infoEls.orbitSection.style.display = isPlanet ? 'none' : '';

      updateLiveInfo();
    }

    function updateLiveInfo() {
      if (!infoEls.dayPeriod) return; // info panel removed from HTML
      if (!focusedBody) return;
      const body = focusedBody;
      if (body.kind === 'planet') {
        const w = body.rotationSpeed ?? DEFAULT_SPIN;
        const period = w > 1e-6 ? (Math.PI * 2 / w) : Infinity;
        infoEls.dayPeriod.textContent = fmtSeconds(period);
        const twoPi = Math.PI * 2;
        const phase = ((body.group.rotation.y % twoPi) + twoPi) % twoPi / twoPi;
        const hh = Math.floor(phase * 24);
        const mm = Math.floor((phase * 24 - hh) * 60);
        infoEls.dayTime.textContent = `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
      } else {
        const m = moons.find(mn => mn.body === body);
        if (!m) return;
        const omega = moonSpeedScalar * Math.pow(MOON_REF_DISTANCE / m.distance, 1.5);
        const period = omega > 1e-6 ? (Math.PI * 2 / omega) : Infinity;
        infoEls.orbitDist.textContent = m.distance.toFixed(1) + ' u';
        infoEls.orbitOmega.textContent = omega.toFixed(3) + ' rad/s';
        infoEls.orbitPeriod.textContent = fmtSeconds(period);
        infoEls.moonSize.textContent = (m.size * 2 * body.baseRadius).toFixed(2) + ' u';
      }
    }

    // ---------- Random names ----------
    // Two name sources live side-by-side: a hand-curated cosmic word bank
    // (mythology + astronomy + Greek letters) and a dynamic CDN import of
    // `unique-names-generator`. The cosmic source is always available; the
    // library source loads in the background and falls back to cosmic if the
    // network fetch fails, so the rename button never breaks.
    let systemName = 'Sol';
    let nameSource = 'cosmic'; // 'cosmic' | 'library'
    let unameLib = null;
    import('https://esm.sh/unique-names-generator@4')
      .then(mod => { unameLib = mod; })
      .catch(err => { console.warn('unique-names-generator failed to load; library mode will fall back to cosmic.', err); });

    const COSMIC_WORDS = {
      greek: ['Alpha','Beta','Gamma','Delta','Epsilon','Zeta','Eta','Theta','Iota','Kappa','Lambda','Mu','Nu','Xi','Omicron','Pi','Rho','Sigma','Tau','Upsilon','Phi','Chi','Psi','Omega'],
      mythos: ['Aether','Apollo','Athena','Cronus','Helios','Hyperion','Selene','Eos','Hekate','Nyx','Erebus','Hades','Poseidon','Ares','Hermes','Triton','Nereus','Thalassa','Gaia','Hestia','Hephaestus','Aurora','Bellona','Ceres','Diana','Faunus','Flora','Freya','Loki','Thor','Odin','Frigg','Tyr','Heimdall','Vali','Vidar','Ymir','Skadi','Bragi','Idun','Mimir','Forseti','Sif'],
      stars: ['Kepler','Hubble','Cassini','Galileo','Webb','Voyager','Pioneer','Sirius','Vega','Rigel','Altair','Procyon','Polaris','Antares','Arcturus','Deneb','Spica','Aldebaran','Capella','Lyra','Cygnus','Orion','Hydra','Draco','Phoenix','Pegasus','Andromeda','Carina','Nebula','Quasar','Pulsar','Cosmos','Nova','Halo','Eon','Helix','Tycho','Brahe'],
      moonish: ['Phobos','Deimos','Charon','Hydra','Nix','Kerberos','Styx','Triton','Nereid','Proteus','Naiad','Despina','Galatea','Larissa','Bianca','Cressida','Desdemona','Juliet','Portia','Rosalind','Belinda','Puck','Miranda','Ariel','Umbriel','Titania','Oberon','Calypso','Telesto','Tethys','Dione','Rhea','Iapetus','Phoebe','Hyperion','Mimas','Enceladus','Pan','Atlas','Prometheus','Pandora','Janus','Epimetheus','Helene','Polydeuces','Methone','Anthe','Pallene','Tarvos','Erriapus','Jarnsaxa','Bebhionn','Skathi','Albiorix','Paaliaq','Siarnaq','Suttungr','Thrymr','Mundilfari','Kari','Fenrir','Aegaeon'],
      designators: ['Prime','Major','Minor','II','III','IV','V','VI','VII','IX','XII','XV','XX'],
    };

    function _pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

    function generateCosmic(kind) {
      const r = Math.random();
      if (kind === 'moon') {
        if (r < 0.6) return _pick(COSMIC_WORDS.moonish);
        if (r < 0.85) return _pick(COSMIC_WORDS.mythos);
        return _pick(COSMIC_WORDS.greek) + ' ' + _pick(COSMIC_WORDS.moonish);
      }
      if (kind === 'system') {
        if (r < 0.4) return _pick(COSMIC_WORDS.stars);
        if (r < 0.7) return _pick(COSMIC_WORDS.greek) + ' ' + _pick(COSMIC_WORDS.stars);
        if (r < 0.9) return _pick(COSMIC_WORDS.mythos) + "'s Reach";
        return _pick(COSMIC_WORDS.stars) + '-' + (100 + ((Math.random() * 900) | 0));
      }
      // planet
      if (r < 0.3) return _pick(COSMIC_WORDS.mythos);
      if (r < 0.55) return _pick(COSMIC_WORDS.stars) + ' ' + _pick(COSMIC_WORDS.designators);
      if (r < 0.75) return _pick(COSMIC_WORDS.greek) + ' ' + _pick(COSMIC_WORDS.mythos);
      if (r < 0.9) return _pick(COSMIC_WORDS.stars) + '-' + (10 + ((Math.random() * 990) | 0));
      return _pick(COSMIC_WORDS.mythos) + ' ' + _pick(COSMIC_WORDS.designators);
    }

    function generateLibrary(kind) {
      if (!unameLib || !unameLib.uniqueNamesGenerator) return generateCosmic(kind);
      const { uniqueNamesGenerator, adjectives, animals, colors, names } = unameLib;
      const cfg = (dicts, sep = ' ') => ({
        dictionaries: dicts, style: 'capital', separator: sep, length: dicts.length,
      });
      try {
        if (kind === 'moon')   return uniqueNamesGenerator(cfg([colors, animals]));
        if (kind === 'system') return uniqueNamesGenerator(cfg([names], '')) + ' System';
        return uniqueNamesGenerator(cfg([adjectives, animals], '-'));
      } catch (_) {
        return generateCosmic(kind);
      }
    }

    function generateName(kind) {
      return nameSource === 'library' ? generateLibrary(kind) : generateCosmic(kind);
    }

    // ---------- UI ----------
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
      btn.onclick = () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        document.getElementById(`tab-${tab}`).classList.add('active');
        
        // Update currentTool based on tab
        if (tab === 'sculpt') currentTool = 'land';
        else if (tab === 'environment') currentTool = 'biome';
        else if (tab === 'colonies') currentTool = 'city';
        else currentTool = 'none';
      };
    });

    const brushRadiusInput   = document.getElementById('brushRadius');
    const brushRadiusVal     = document.getElementById('brushRadiusVal');
    const brushRadiusInputB  = document.getElementById('brushRadiusB');
    const brushRadiusValB    = document.getElementById('brushRadiusValB');
    
    const brushStrengthInput = document.getElementById('brushStrength');
    const brushStrengthVal   = document.getElementById('brushStrengthVal');
    
    const sculptRaiseBtn     = document.getElementById('sculptRaise');
    const sculptLowerBtn     = document.getElementById('sculptLower');
    
    const pauseRotInput      = document.getElementById('pauseRot');
    const moonSpeedInput     = document.getElementById('moonSpeed');
    const moonSpeedVal       = document.getElementById('moonSpeedVal');
    const moonsListEl        = document.getElementById('moonsList');
    const addMoonBtn         = document.getElementById('addMoon');
    const seedInput          = document.getElementById('seedInput');
    const genAmpInput        = document.getElementById('genAmp');
    const genAmpVal          = document.getElementById('genAmpVal');
    const genSeaInput        = document.getElementById('genSea');
    const genSeaVal          = document.getElementById('genSeaVal');
    const regenBtn           = document.getElementById('regenBtn');
    const randomSeedBtn      = document.getElementById('randomSeedBtn');
    const focusPlanetBtn     = document.getElementById('focusPlanet');
    const focusNameEl        = document.getElementById('focusName');

    const archetypeSelect    = document.getElementById('archetypeSelect');

    archetypeSelect.onchange = () => {
      currentArchetype = archetypeSelect.value;
      const arch = ARCHETYPES[currentArchetype];
      if (arch) {
        genAmpInput.value = arch.amp * 10;
        genSeaInput.value = arch.sea * 100;
        syncGenLabels();
        regenBtn.click();
        updateBiomeTools();
      }
    };

    function updateBiomeTools() {
      const select = document.getElementById('biomeSelect');
      const hint = document.getElementById('biomeHint');
      select.innerHTML = '<option value="0">Natural State</option>';

      // Moons get a deliberately tiny biome palette — focus drives the choice.
      if (focusedBody && focusedBody.kind === 'moon') {
        MOON_BIOME_OPTIONS.forEach(opt => {
          const el = document.createElement('option');
          el.value = opt.v;
          el.textContent = opt.n;
          select.appendChild(el);
        });
        if (hint) hint.textContent = `Lunar palette · painting on ${focusedBody.name}`;
        select.value = 0;
        selectedBiome = 0;
        return;
      }

      const options = {
        terrestrial: [
          {v: 1, n: 'Forest'}, {v: 2, n: 'Desert'}, {v: 4, n: 'Tundra'}
        ],
        ocean: [
          {v: 11, n: 'Coral Reef'}, {v: 12, n: 'Kelp Forest'}, {v: 13, n: 'Abyssal Trench'}
        ],
        lava: [
          {v: 5, n: 'Obsidian'}, {v: 6, n: 'Magma Flow'}, {v: 14, n: 'Sulfur Vent'}
        ],
        desert: [
          {v: 15, n: 'Oasis'}, {v: 16, n: 'Ancient Ruins'}, {v: 17, n: 'Red Sand'}
        ],
        ice_planet: [
          {v: 18, n: 'Glacier'}, {v: 19, n: 'Cryo-Volcano'}, {v: 20, n: 'Blue Ice'}
        ],
        jungle: [
          {v: 21, n: 'Exotic Bloom'}, {v: 22, n: 'River Path'}, {v: 23, n: 'Dense Canopy'}
        ],
        moon_like: [
          {v: BIOME.MARE, n: 'Mare'}, {v: BIOME.REGOLITH, n: 'Regolith'}, {v: BIOME.FROST, n: 'Frost'}
        ],
        toxic: [
          {v: 9, n: 'Acid Sludge'}, {v: 10, n: 'Mutation Bloom'}, {v: 25, n: 'Gas Vent'}
        ],
        metal: [
          {v: 26, n: 'Rust Belt'}, {v: 27, n: 'Gold Vein'}, {v: 28, n: 'Chrome Flat'}
        ],
        living: [
          {v: 29, n: 'Neural Path'}, {v: 30, n: 'Pulsing Organ'}, {v: 31, n: 'Tendon'}
        ],
        storm: [
          {v: 32, n: 'Lightning Scar'}, {v: 33, n: 'Cyclone Eye'}, {v: 34, n: 'Vortex'}
        ],
        venusian: [
          {v: 35, n: 'Sulfur Cloud'}, {v: 36, n: 'Volcanic Plain'}, {v: 37, n: 'Greenhouse Haze'}
        ]
      };

      // Read archetype from the focused planet, not the global UI state — the
      // user expects the biome list to reflect the body they're painting on
      // (e.g. focusing a desert planet should hide Forest/Tundra entirely).
      const archKey = (focusedBody && focusedBody.kind === 'planet')
        ? (focusedBody.archetype || 'terrestrial')
        : currentArchetype;
      // No fallback to terrestrial: archetypes without a dedicated biome list
      // get only Natural State, which is more honest than showing wrong biomes.
      const archOptions = options[archKey] || [];
      archOptions.forEach(opt => {
        const el = document.createElement('option');
        el.value = opt.v;
        el.textContent = opt.n;
        select.appendChild(el);
      });

      if (hint) {
        const archName = (ARCHETYPES[archKey] && ARCHETYPES[archKey].name) || 'Surface';
        const bodyName = focusedBody && focusedBody.kind === 'planet' ? focusedBody.name : 'planet';
        hint.textContent = archOptions.length
          ? `${archName} palette · painting on ${bodyName}`
          : `${archName} · no surface biomes available`;
      }

      select.value = 0;
      selectedBiome = 0;
    }
    const cityNameInput      = document.getElementById('cityNameInput');

    randomSeedBtn.onclick = () => {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let newSeed = '';
      for(let i=0; i<8; i++) newSeed += chars.charAt(Math.floor(Math.random() * chars.length));
      seedInput.value = newSeed;
      // Automatically trigger regen for better UX
      regenBtn.click();
    };

    function syncBrushRadius(val) {
      brushRadius = sliderToBrushRadius(val);
      brushRadiusInput.value = val;
      brushRadiusInputB.value = val;
      brushRadiusVal.textContent = brushRadius.toFixed(2);
      brushRadiusValB.textContent = brushRadius.toFixed(2);
    }

    brushRadiusInput.oninput = () => syncBrushRadius(parseInt(brushRadiusInput.value, 10));
    brushRadiusInputB.oninput = () => syncBrushRadius(parseInt(brushRadiusInputB.value, 10));

    brushStrengthInput.oninput = () => {
      brushStrength = sliderToBrushStrength(parseInt(brushStrengthInput.value, 10));
      brushStrengthVal.textContent = brushStrength.toFixed(1);
    };

    sculptRaiseBtn.onclick = () => {
      brushRaise = true;
      sculptRaiseBtn.classList.add('active');
      sculptLowerBtn.classList.remove('active');
    };
    sculptLowerBtn.onclick = () => {
      brushRaise = false;
      sculptRaiseBtn.classList.remove('active');
      sculptLowerBtn.classList.add('active');
    };

    pauseRotInput.onchange = () => { paused = pauseRotInput.checked; };
    moonSpeedInput.oninput = () => {
      moonSpeedVal.textContent = moonSpeedInput.value;
      moonSpeedScalar = (parseInt(moonSpeedInput.value, 10) / 3000) * Math.PI * 2;
    };

    const showOrbitsInput = document.getElementById('showOrbits');
    orbitLinesGroup.visible = showOrbitsInput.checked;
    showOrbitsInput.onchange = () => {
      orbitLinesGroup.visible = showOrbitsInput.checked;
    };

    biomeSelect.onchange = () => {
      selectedBiome = parseInt(biomeSelect.value, 10);
    };

    // --- Atmosphere sliders ---
    const atmoThickInput      = document.getElementById('atmoThick');
    const atmoThickValEl      = document.getElementById('atmoThickVal');
    const atmoDensityInput    = document.getElementById('atmoDensity');
    const atmoDensityValEl    = document.getElementById('atmoDensityVal');
    const atmoCoverageInput   = document.getElementById('atmoCoverage');
    const atmoCoverageValEl   = document.getElementById('atmoCoverageVal');
    const atmoHintEl          = document.getElementById('atmoHint');

    // Whoever is in focus when the slider moves is the body that gets edited.
    // No focus, or focus on a body without gas, means the change is a no-op.
    function applyAtmoSliderToFocus() {
      const b = focusedBody;
      if (!b || !b.gasMesh || !b.matter || !b.matter.gas) return;
      b.gasThickness = parseInt(atmoThickInput.value, 10) / 100;       // 1.00..1.40
      b.gasDensity   = parseInt(atmoDensityInput.value, 10) / 100;     // 0.00..1.00
      b.gasCoverage  = parseInt(atmoCoverageInput.value, 10) / 100;    // 0.00..1.00
      applyGasShell(b);
      atmoThickValEl.textContent    = b.gasThickness.toFixed(2);
      atmoDensityValEl.textContent  = b.gasDensity.toFixed(2);
      atmoCoverageValEl.textContent = b.gasCoverage.toFixed(2);
    }
    atmoThickInput.oninput    = applyAtmoSliderToFocus;
    atmoDensityInput.oninput  = applyAtmoSliderToFocus;
    atmoCoverageInput.oninput = applyAtmoSliderToFocus;

    // --- Ring controls ---
    const ringsEnabledInput   = document.getElementById('ringsEnabled');
    const ringsIntensityInput = document.getElementById('ringsIntensity');
    const ringsIntensityValEl = document.getElementById('ringsIntensityVal');
    const ringsHintEl         = document.getElementById('ringsHint');

    function applyRingsSliderToFocus() {
      const b = focusedBody;
      if (!b || !b.ringMesh || b.kind !== 'planet') return;
      b.rings.enabled   = !!ringsEnabledInput.checked;
      b.rings.intensity = parseInt(ringsIntensityInput.value, 10) / 100;
      ringsIntensityValEl.textContent = b.rings.intensity.toFixed(2);
      applyRingsToBody(b);
      // Toggling enable flips whether the intensity row is greyed; re-sync.
      syncRingsToFocus();
    }
    ringsEnabledInput.onchange   = applyRingsSliderToFocus;
    ringsIntensityInput.oninput  = applyRingsSliderToFocus;

    regenBtn.onclick = () => {
      // Regenerate operates on the focused body (planet or moon). The archetype
      // global only changes palette for planets — moons keep MOON_PALETTE.
      const target = focusedBody && (focusedBody.kind === 'planet' || focusedBody.kind === 'moon')
        ? focusedBody : planet;
      const seed = seedInput.value || 'planet';
      const amp = sliderToAmplitude(parseInt(genAmpInput.value, 10));
      const sea = sliderToSeaCoverage(parseInt(genSeaInput.value, 10));
      regenerateBody(target, seed, amp, sea);
      target.currentSeed = seed;
      target.currentAmp = amp;
      target.currentSea = sea;
      if (target.kind === 'planet') target.archetype = currentArchetype;
      if (target === planet) planetCurrentSeed = seed;
      const moonEntry = moons.find(m => m.body === target);
      if (moonEntry) moonEntry.seed = seed;
      // Matter may have changed (e.g. desert→terrestrial gained an ocean and
      // atmosphere) — re-sync the atmo sliders to the new state.
      if (typeof syncAtmoSlidersToFocus === 'function') syncAtmoSlidersToFocus();
      updateInfoPanel();
    };

    focusPlanetBtn.onclick = () => setFocus(planet);

    // Initialize values
    syncBrushRadius(parseInt(brushRadiusInput.value, 10));
    brushStrength = sliderToBrushStrength(parseInt(brushStrengthInput.value, 10));
    brushStrengthVal.textContent = brushStrength.toFixed(1);

    function sliderToBrushRadius(v) { return v / 100; }
    function sliderToBrushStrength(v) { return v / 10; }
    function sliderToAmplitude(v) { return v / 10; }
    function sliderToSeaCoverage(v) { return v / 100; }

    function syncGenLabels() {
      genAmpVal.textContent = sliderToAmplitude(parseInt(genAmpInput.value, 10)).toFixed(1);
      genSeaVal.textContent = genSeaInput.value + '%';
    }
    genAmpInput.oninput = syncGenLabels;
    genSeaInput.oninput = syncGenLabels;
    syncGenLabels();

    // ---------- Context-aware left panel ----------
    // Each tab points at the focused entity; sliders, regen, deploy buttons all
    // operate on the focused body. When focus changes we (1) refresh the slider
    // values from the focused entity's state and (2) disable sections that can't
    // act on the current focus (e.g. archetype select when a moon is focused).

    const classifyContextEl  = document.getElementById('classifyContext');
    const systemContextEl    = document.getElementById('systemContext');
    const archetypeHeaderEl  = document.getElementById('archetypeHeader');
    const classifyArchSection = archetypeSelect.closest('label');
    const classifyGenLabels  = [genAmpInput.closest('label'), genSeaInput.closest('label')];
    const rosterHintEl       = document.getElementById('rosterHint');
    const deployPlanetBtn    = document.getElementById('deployPlanetBtn');
    const removePlanetBtn    = document.getElementById('removePlanetBtn');
    const bodyOrbitSectionEl = document.getElementById('bodyOrbitSection');
    const bodyOrbitHeaderEl  = document.getElementById('bodyOrbitHeader');
    const bodyDistInput      = document.getElementById('bodyDistInput');
    const bodyDistVal        = document.getElementById('bodyDistVal');
    const bodySpeedRow       = document.getElementById('bodySpeedRow');
    const bodySpeedInput     = document.getElementById('bodySpeedInput');
    const bodySpeedVal       = document.getElementById('bodySpeedVal');
    const bodySpinRow        = document.getElementById('bodySpinRow');
    const bodySpinInput      = document.getElementById('bodySpinInput');
    const bodySpinVal        = document.getElementById('bodySpinVal');
    const bodySizeInput      = document.getElementById('bodySizeInput');
    const bodySizeVal        = document.getElementById('bodySizeVal');
    const satellitesSectionEl= document.getElementById('satellitesSection');

    // Range mapping. Different ranges for planets vs moons so the slider feels
    // sensible at either scale.
    const PLANET_DIST = { sliderMin: 120, sliderMax: 900, scale: 1 };
    const MOON_DIST   = { sliderMin: 5,   sliderMax: 60,  scale: 1 };
    const PLANET_SIZE = { sliderMin: 3,   sliderMax: 30,  div: 10 };  // scale 0.3..3.0
    const MOON_SIZE   = { sliderMin: 2,   sliderMax: 40,  div: 10 };  // scale 0.2..4.0
    const PLANET_SPEED= { sliderMin: 1,   sliderMax: 40,  div: 100 }; // 0.01..0.40 rad/s
    // Spin slider 0..100 maps linearly: w = (v / 3000) * 2π → 0..~0.21 rad/s.
    const PLANET_SPIN = { sliderMin: 0,   sliderMax: 100, div: 3000 };
    const spinSliderToRad = v => (v / PLANET_SPIN.div) * Math.PI * 2;
    const spinRadToSlider = w => Math.round((w / (Math.PI * 2)) * PLANET_SPIN.div);

    function setRange(input, min, max) {
      input.min = String(min); input.max = String(max);
    }

    function applyFocusToLeftPanel() {
      const isPlanet = focusedBody && focusedBody.kind === 'planet';
      const isMoon   = focusedBody && focusedBody.kind === 'moon';

      // --- Classify tab ---
      if (isPlanet) {
        classifyContextEl.textContent = `Editing: ${focusedBody.name}`;
        archetypeSelect.value = focusedBody.archetype || 'terrestrial';
        currentArchetype = focusedBody.archetype || 'terrestrial';
        seedInput.value = focusedBody.currentSeed || planetCurrentSeed || '';
        genAmpInput.value = Math.round((focusedBody.currentAmp ?? 2.0) * 10);
        genSeaInput.value = Math.round((focusedBody.currentSea ?? 0.55) * 100);
        syncGenLabels();
        classifyArchSection.classList.remove('is-disabled-section');
        classifyGenLabels.forEach(l => l && l.classList.remove('is-disabled-section'));
        regenBtn.disabled = false;
        removePlanetBtn.disabled = planets.length <= 1;
        rosterHintEl.textContent = `${planets.length} planet${planets.length === 1 ? '' : 's'} in system · keep ≥ 1`;
      } else if (isMoon) {
        classifyContextEl.textContent = `Editing: ${focusedBody.name} (satellite)`;
        const moonEntry = moons.find(m => m.body === focusedBody);
        seedInput.value = (moonEntry && moonEntry.seed) || '';
        genAmpInput.value = Math.round((focusedBody.currentAmp ?? 1.6) * 10);
        genSeaInput.value = Math.round((focusedBody.currentSea ?? 0.0) * 100);
        syncGenLabels();
        // Archetype doesn't apply to moons — gray it out but keep regen usable.
        classifyArchSection.classList.add('is-disabled-section');
        classifyGenLabels.forEach(l => l && l.classList.remove('is-disabled-section'));
        regenBtn.disabled = false;
        removePlanetBtn.disabled = true;
        rosterHintEl.textContent = 'Focus a planet to add or remove planets';
      } else {
        // City focus or system view
        const lbl = focusedCity ? `Editing: ${focusedCity.name}` : 'No body focused · system view';
        classifyContextEl.textContent = lbl;
        classifyArchSection.classList.add('is-disabled-section');
        classifyGenLabels.forEach(l => l && l.classList.add('is-disabled-section'));
        regenBtn.disabled = true;
        removePlanetBtn.disabled = true;
        rosterHintEl.textContent = focusedCity
          ? 'Focus the planet to manage roster'
          : 'No planet focused · click ↓ on the nav to focus one';
      }

      // --- System tab ---
      if (isPlanet) {
        systemContextEl.textContent = `Editing: ${focusedBody.name}`;
        const entry = planets.find(p => p.body === focusedBody);
        bodyOrbitHeaderEl.textContent = 'Orbit (around star)';
        setRange(bodyDistInput, PLANET_DIST.sliderMin, PLANET_DIST.sliderMax);
        setRange(bodySizeInput, PLANET_SIZE.sliderMin, PLANET_SIZE.sliderMax);
        setRange(bodySpeedInput, PLANET_SPEED.sliderMin, PLANET_SPEED.sliderMax);
        setRange(bodySpinInput, PLANET_SPIN.sliderMin, PLANET_SPIN.sliderMax);
        bodySpeedRow.style.display = '';
        bodySpinRow.style.display = '';
        if (entry) {
          bodyDistInput.value = Math.round(entry.orbit.distance);
          bodyDistVal.textContent = entry.orbit.distance.toFixed(0);
          bodySpeedInput.value = Math.max(1, Math.round(entry.orbit.speed * 100));
          bodySpeedVal.textContent = entry.orbit.speed.toFixed(2);
        }
        const spin = focusedBody.rotationSpeed ?? DEFAULT_SPIN;
        bodySpinInput.value = spinRadToSlider(spin);
        bodySpinVal.textContent = spin.toFixed(2);
        bodySizeInput.value = Math.round(focusedBody.group.scale.x * PLANET_SIZE.div);
        bodySizeVal.textContent = focusedBody.group.scale.x.toFixed(2);
        bodyOrbitSectionEl.classList.remove('is-disabled-section');
        satellitesSectionEl.style.display = '';
      } else if (isMoon) {
        systemContextEl.textContent = `Editing: ${focusedBody.name}`;
        const m = moons.find(mn => mn.body === focusedBody);
        bodyOrbitHeaderEl.textContent = `Orbit (around ${m?.parent?.name || 'parent'})`;
        setRange(bodyDistInput, MOON_DIST.sliderMin, MOON_DIST.sliderMax);
        setRange(bodySizeInput, MOON_SIZE.sliderMin, MOON_SIZE.sliderMax);
        bodySpeedRow.style.display = 'none'; // moon speed is global
        bodySpinRow.style.display = 'none';  // spin is planets-only for now
        if (m) {
          bodyDistInput.value = Math.round(m.distance);
          bodyDistVal.textContent = m.distance.toFixed(0);
          bodySizeInput.value = Math.round(m.size * MOON_SIZE.div);
          bodySizeVal.textContent = m.size.toFixed(2);
        }
        bodyOrbitSectionEl.classList.remove('is-disabled-section');
        satellitesSectionEl.style.display = 'none'; // moons don't host satellites
      } else {
        systemContextEl.textContent = focusedCity
          ? `Editing: ${focusedCity.name} (city)`
          : 'No body focused';
        bodyOrbitSectionEl.classList.add('is-disabled-section');
        satellitesSectionEl.style.display = focusedCity ? 'none' : 'none';
      }

      // --- Environment tab: atmosphere sliders ---
      syncAtmoSlidersToFocus();
      // --- Environment tab: ring controls ---
      syncRingsToFocus();
    }

    // Mirror focused body's gas state into the atmo sliders + hint. If the
    // focused body has no gas (or isn't a planet), gray out the controls and
    // explain why so the panel doesn't look broken.
    function syncAtmoSlidersToFocus() {
      const b = focusedBody;
      const hasGas = !!(b && b.matter && b.matter.gas);
      // Coverage controls the cloud-pattern threshold, which only applies to
      // atmosphere mode — gas-giant bodies have no separate cloud layer.
      const coverageApplies = hasGas && b.matter.gas !== 'full';
      const atmoThickRow    = atmoThickInput.closest('label');
      const atmoDensityRow  = atmoDensityInput.closest('label');
      const atmoCoverageRow = atmoCoverageInput.closest('label');
      atmoThickInput.disabled    = !hasGas;
      atmoDensityInput.disabled  = !hasGas;
      atmoCoverageInput.disabled = !coverageApplies;
      if (atmoThickRow)    atmoThickRow.classList.toggle('is-disabled-section', !hasGas);
      if (atmoDensityRow)  atmoDensityRow.classList.toggle('is-disabled-section', !hasGas);
      if (atmoCoverageRow) atmoCoverageRow.classList.toggle('is-disabled-section', !coverageApplies);
      if (hasGas) {
        const t = b.gasThickness ?? 1.10;
        const d = b.gasDensity ?? 0.20;
        const c = b.gasCoverage ?? 0.35;
        atmoThickInput.value      = Math.round(t * 100);
        atmoDensityInput.value    = Math.round(d * 100);
        atmoCoverageInput.value   = Math.round(c * 100);
        atmoThickValEl.textContent    = t.toFixed(2);
        atmoDensityValEl.textContent  = d.toFixed(2);
        atmoCoverageValEl.textContent = coverageApplies ? c.toFixed(2) : '—';
        atmoHintEl.textContent = b.matter.gas === 'full'
          ? `Gaseous body · adjust size and density`
          : `Atmosphere wrapping ${b.name}`;
      } else {
        atmoThickValEl.textContent    = '—';
        atmoDensityValEl.textContent  = '—';
        atmoCoverageValEl.textContent = '—';
        atmoHintEl.textContent = (b && b.kind === 'planet')
          ? `${b.name} has no atmosphere`
          : 'No atmosphere on this body';
      }
    }

    // Rings are planet-only. Disable the controls otherwise, and grey the
    // intensity row when rings are toggled off so it reads as "no effect now".
    function syncRingsToFocus() {
      const b = focusedBody;
      const isPlanet = !!(b && b.kind === 'planet' && b.ringMesh);
      const enabledRow   = ringsEnabledInput.closest('label');
      const intensityRow = ringsIntensityInput.closest('label');
      ringsEnabledInput.disabled   = !isPlanet;
      ringsIntensityInput.disabled = !isPlanet || !(b && b.rings && b.rings.enabled);
      if (enabledRow)   enabledRow.classList.toggle('is-disabled-section', !isPlanet);
      if (intensityRow) intensityRow.classList.toggle('is-disabled-section', !isPlanet || !(b && b.rings && b.rings.enabled));
      if (isPlanet) {
        const r = b.rings;
        ringsEnabledInput.checked   = !!r.enabled;
        ringsIntensityInput.value   = Math.round((r.intensity ?? 0.65) * 100);
        ringsIntensityValEl.textContent = (r.intensity ?? 0.65).toFixed(2);
        ringsHintEl.textContent = r.enabled
          ? `Rings encircle ${b.name}`
          : `Toggle to add rings to ${b.name}`;
      } else {
        ringsEnabledInput.checked = false;
        ringsIntensityValEl.textContent = '—';
        ringsHintEl.textContent = (b && b.kind === 'moon')
          ? 'Satellites cannot have rings'
          : 'Focus a planet to add rings';
      }
    }

    // --- Body orbit slider handlers ---
    bodyDistInput.oninput = () => {
      const v = parseInt(bodyDistInput.value, 10);
      if (focusedBody?.kind === 'planet') {
        const entry = planets.find(p => p.body === focusedBody);
        if (entry) {
          entry.orbit.distance = v;
          updatePlanetOrbitPosition(entry);
          refreshOrbitLine(entry);
        }
      } else if (focusedBody?.kind === 'moon') {
        const idx = moons.findIndex(mn => mn.body === focusedBody);
        if (idx >= 0) setMoonDistance(idx, v);
      }
      bodyDistVal.textContent = v.toFixed(0);
    };

    bodySpeedInput.oninput = () => {
      const v = parseInt(bodySpeedInput.value, 10) / PLANET_SPEED.div;
      if (focusedBody?.kind === 'planet') {
        const entry = planets.find(p => p.body === focusedBody);
        if (entry) entry.orbit.speed = v;
        bodySpeedVal.textContent = v.toFixed(2);
      }
    };

    bodySpinInput.oninput = () => {
      if (focusedBody?.kind !== 'planet') return;
      const w = spinSliderToRad(parseInt(bodySpinInput.value, 10));
      focusedBody.rotationSpeed = w;
      bodySpinVal.textContent = w.toFixed(2);
      updateLiveInfo();
    };

    bodySizeInput.oninput = () => {
      const raw = parseInt(bodySizeInput.value, 10);
      if (focusedBody?.kind === 'planet') {
        const scale = raw / PLANET_SIZE.div;
        focusedBody.group.scale.setScalar(scale);
        bodySizeVal.textContent = scale.toFixed(2);
      } else if (focusedBody?.kind === 'moon') {
        const scale = raw / MOON_SIZE.div;
        const idx = moons.findIndex(mn => mn.body === focusedBody);
        if (idx >= 0) setMoonSize(idx, scale);
        bodySizeVal.textContent = scale.toFixed(2);
      }
    };

    // ---------- Add / Remove planet ----------
    const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];
    function nextPlanetName() {
      // Find lowest unused roman so removed slots get reused first.
      const used = new Set(planets.map(p => p.body.name));
      for (let i = 0; i < ROMAN.length; i++) {
        const n = `Planet ${ROMAN[i]}`;
        if (!used.has(n)) return n;
      }
      return `Planet ${planets.length + 1}`;
    }

    function deployNewPlanet() {
      if (planets.length >= 8) return null;
      // Place beyond the outermost existing orbit so it doesn't intersect.
      const maxDist = planets.reduce((m, p) => Math.max(m, p.orbit.distance), 120);
      const dist = maxDist + 160;
      // Pick an archetype that isn't on every planet already, for variety.
      const archKeys = Object.keys(ARCHETYPES);
      const used = planets.map(p => p.body.archetype);
      const arch = archKeys.find(a => !used.includes(a)) || 'terrestrial';
      const archSpec = ARCHETYPES[arch];
      const idx = planets.length;
      const name = nextPlanetName();
      const seed = `planet-${idx + 1}-${Math.floor(Math.random() * 1e4).toString(36)}`;

      const body = createBody({
        kind: 'planet',
        name,
        baseRadius: BASE_RADIUS,
        detail: ICO_DETAIL,
        hasOcean: archSpec.hasOcean,
      });
      bodies.push(body);
      scene.add(body.group);

      const prev = currentArchetype;
      currentArchetype = arch;
      regenerateBody(body, seed, archSpec.amp, archSpec.sea);
      currentArchetype = prev;
      body.currentAmp = archSpec.amp;
      body.currentSea = archSpec.sea;

      registerPlanet(body, arch, seed, {
        angle: Math.random() * Math.PI * 2,
        distance: dist,
        // Outer planets are slower (loose Kepler-ish feel without real physics).
        speed: 0.06 / (1 + idx * 0.35),
        inclination: (Math.random() - 0.5) * 0.3,
      });
      return body;
    }

    function removeFocusedPlanet() {
      if (!focusedBody || focusedBody.kind !== 'planet') return;
      if (planets.length <= 1) return;
      const target = focusedBody;
      // Remove moons of this planet first.
      for (let i = moons.length - 1; i >= 0; i--) {
        if (moons[i].parent === target) {
          if (focusedBody === moons[i].body) {
            // moot since focusedBody is the planet, not the moon — but be safe
          }
          scene.remove(moons[i].body.group);
          const bi = bodies.indexOf(moons[i].body);
          if (bi >= 0) bodies.splice(bi, 1);
          moons[i].body.geo.dispose();
          moons[i].body.mesh.material.dispose();
          freeMoonSlot(moons[i].parent, moons[i].slot);
          moons.splice(i, 1);
        }
      }
      // Remove cities on this planet.
      for (let i = cities.length - 1; i >= 0; i--) {
        if (cities[i].body === target) {
          if (focusedCity === cities[i]) focusedCity = null;
          target.group.remove(cities[i].mesh);
          cities.splice(i, 1);
        }
      }
      // Remove the planet itself.
      scene.remove(target.group);
      const bi = bodies.indexOf(target);
      if (bi >= 0) bodies.splice(bi, 1);
      const pi = planets.findIndex(p => p.body === target);
      if (pi >= 0) {
        disposeOrbitLine(planets[pi]);
        planets.splice(pi, 1);
      }
      target.geo.dispose();
      target.mesh.material.dispose();
      if (target.oceanMesh) {
        target.oceanMesh.geometry.dispose();
        target.oceanMesh.material.dispose();
      }
      if (target.ringMesh) {
        target.ringMesh.geometry.dispose();
        target.ringMesh.material.dispose();
      }
      setFocus(planets[0].body);
      renderCityList();
    }

    deployPlanetBtn.onclick = () => {
      const b = deployNewPlanet();
      if (b) setFocus(b);
    };
    removePlanetBtn.onclick = removeFocusedPlanet;

    focusPlanetBtn.onclick = () => setFocus(planet);

    function renderMoonsList() {
      renderNavBodies();
      // Only show moons of the focused planet. With multiple planets in the
      // system, mixing them all into one list would be confusing.
      const parent = (focusedBody && focusedBody.kind === 'planet') ? focusedBody : null;
      const own = parent ? moons.filter(m => m.parent === parent) : [];

      if (!parent) {
        moonsListEl.innerHTML = '';
        addMoonBtn.disabled = true;
        return;
      }

      if (own.length === 0) {
        moonsListEl.innerHTML = `<div class="empty-state">No satellites in orbit · deploy one to begin</div>`;
        addMoonBtn.disabled = false;
        return;
      }

      moonsListEl.innerHTML = own.map((m, i) => {
        const sizeSlider = Math.round(m.size * 10);
        const distSlider = Math.round(m.distance);
        const focusedCls = focusedBody === m.body ? ' focused' : '';
        const apparent = (m.size * 2 * m.body.baseRadius).toFixed(2);
        return `
          <div class="moon-card${focusedBody === m.body ? ' is-focused' : ''}" data-local="${i}">
            <div class="moon-card-header">
              <span class="moon-card-title">${m.body.name}</span>
              <div class="moon-card-actions">
                <button class="moon-focus focus-btn small-btn${focusedCls}" type="button">Focus</button>
                <button class="moon-remove small-btn" type="button" aria-label="Remove moon">×</button>
              </div>
            </div>
            <div class="moon-card-body">
              <label>Size <input class="moon-size-input" type="range" min="2" max="40" value="${sizeSlider}"><span class="val moon-size-val">${sizeSlider}</span></label>
              <label>Dist <input class="moon-dist-input" type="range" min="14" max="60" value="${distSlider}"><span class="val moon-dist-val">${distSlider}</span></label>
              <div class="moon-meta">
                <span>Seed · ${m.seed}</span>
                <span>⌀ ${apparent} u</span>
              </div>
            </div>
          </div>
        `;
      }).join('');

      moonsListEl.querySelectorAll('.moon-card').forEach((row) => {
        const localIdx = parseInt(row.dataset.local, 10);
        const moonRef = own[localIdx];
        // Map back to the global moons[] index for the setter helpers.
        const globalIdx = () => moons.indexOf(moonRef);
        const sizeIn = row.querySelector('.moon-size-input');
        const sizeValEl = row.querySelector('.moon-size-val');
        const distIn = row.querySelector('.moon-dist-input');
        const distValEl = row.querySelector('.moon-dist-val');
        const focusBtn = row.querySelector('.moon-focus');
        const rmBtn = row.querySelector('.moon-remove');
        sizeIn.oninput = () => {
          sizeValEl.textContent = sizeIn.value;
          setMoonSize(globalIdx(), parseInt(sizeIn.value, 10) / 10);
        };
        distIn.oninput = () => {
          distValEl.textContent = distIn.value;
          setMoonDistance(globalIdx(), parseInt(distIn.value, 10));
        };
        focusBtn.onclick = () => { if (moonRef) setFocus(moonRef.body); };
        rmBtn.onclick = () => {
          removeMoonAt(globalIdx());
          renderMoonsList();
        };
      });

      addMoonBtn.disabled = own.length >= MAX_MOONS;
    }

    function renderFocusBadges() {
      focusPlanetBtn.classList.toggle('focused', focusedBody === planet);
      renderMoonsList();
    }

    // ---------- Hierarchy navigation ----------
    // Three levels: System (no body focused) → Body (planet or moon) → City.
    // Arrows: ↑ zoom out, ↓ zoom in to first child, ←/→ cycle siblings.
    const navLevelEl = document.getElementById('navFocusLevel');
    const navNameEl  = document.getElementById('navFocusName');
    const navSubEl   = document.getElementById('navFocusSub');
    const navUpBtn   = document.getElementById('navUp');
    const navDownBtn = document.getElementById('navDown');
    const navLeftBtn = document.getElementById('navLeft');
    const navRightBtn= document.getElementById('navRight');
    const navBreadcrumbEl = document.getElementById('navBreadcrumb');
    const navRandomBtn    = document.getElementById('navRandomBtn');
    const nameSourceSelect = document.getElementById('nameSourceSelect');

    // navNameEl is contenteditable. While the user has it focused for typing,
    // skip programmatic updates so renders don't clobber their unsaved input.
    function setNavNameText(text) {
      if (document.activeElement === navNameEl) return;
      navNameEl.textContent = text;
    }

    function setSystemFocus() {
      focusedBody = null;
      focusedCity = null;
      focusNameEl.textContent = 'System View';
      const maxOrbit = planets.reduce((acc, p) => Math.max(acc, p.orbit.distance), 40);
      const dist = Math.max(220, maxOrbit * 3.0 + 60);
      let dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0.4, 1);
      dir.normalize();
      controls.target.set(0, 0, 0);
      camera.position.copy(controls.target).addScaledVector(dir, dist);
      renderFocusBadges();
      updateInfoPanel();
      applyFocusToLeftPanel();
    }

    function navUp() {
      if (focusedCity) { setFocus(focusedBody); return; }
      if (focusedBody?.kind === 'moon') {
        const m = moons.find(mn => mn.body === focusedBody);
        if (m?.parent) { setFocus(m.parent); return; }
      }
      setSystemFocus();
    }

    function navDown() {
      if (focusedCity) return;
      if (!focusedBody) {
        if (planets.length) setFocus(planets[0].body);
        return;
      }
      if (focusedBody.kind === 'planet') {
        const myMoons = moons.filter(m => m.parent === focusedBody);
        if (myMoons.length) { setFocus(myMoons[0].body); return; }
        const myCities = cities.filter(c => c.body === focusedBody);
        if (myCities.length) setCityFocus(myCities[0]);
        return;
      }
      // moon
      const myCities = cities.filter(c => c.body === focusedBody);
      if (myCities.length) setCityFocus(myCities[0]);
    }

    function navSibling(dir) {
      if (focusedCity) {
        const sibs = cities.filter(c => c.body === focusedCity.body);
        if (sibs.length < 2) return;
        const idx = sibs.indexOf(focusedCity);
        setCityFocus(sibs[(idx + dir + sibs.length) % sibs.length]);
        return;
      }
      if (!focusedBody) {
        if (planets.length) setFocus(planets[0].body);
        return;
      }
      let sibs;
      if (focusedBody.kind === 'planet') {
        sibs = planets.map(p => p.body);
      } else {
        const m = moons.find(mn => mn.body === focusedBody);
        sibs = moons.filter(mn => mn.parent === m?.parent).map(mn => mn.body);
      }
      if (sibs.length < 2) return;
      const idx = sibs.indexOf(focusedBody);
      setFocus(sibs[(idx + dir + sibs.length) % sibs.length]);
    }

    function renderNavBodies() {
      if (!navLevelEl) return;

      // Breadcrumb mirrors the (renameable) system name.
      if (navBreadcrumbEl) navBreadcrumbEl.textContent = `Milky Way · ${systemName}`;

      // Focus card content
      if (focusedCity) {
        navLevelEl.textContent = 'Settlement';
        setNavNameText(focusedCity.name.toUpperCase());
        navSubEl.textContent = `On ${focusedCity.body.name}`;
      } else if (focusedBody?.kind === 'planet') {
        const idx = planets.findIndex(p => p.body === focusedBody);
        navLevelEl.textContent = `Planet · N° ${idx + 1}`;
        setNavNameText(focusedBody.name.toUpperCase());
        const arch = ARCHETYPES[focusedBody.archetype || 'terrestrial'];
        const moonCount = moons.filter(m => m.parent === focusedBody).length;
        navSubEl.textContent = `${arch?.name || 'Planet'} · ${moonCount} satellite${moonCount === 1 ? '' : 's'}`;
      } else if (focusedBody?.kind === 'moon') {
        const m = moons.find(mn => mn.body === focusedBody);
        navLevelEl.textContent = 'Satellite';
        setNavNameText(focusedBody.name.toUpperCase());
        navSubEl.textContent = m?.parent ? `Orbiting ${m.parent.name}` : '';
      } else {
        navLevelEl.textContent = 'System';
        setNavNameText(systemName.toUpperCase());
        navSubEl.textContent = `${planets.length} planets · ${moons.length} satellites`;
      }

      // Arrow availability
      navUpBtn.disabled = !focusedBody && !focusedCity;

      if (focusedCity) navDownBtn.disabled = true;
      else if (focusedBody?.kind === 'planet') {
        navDownBtn.disabled = !moons.some(m => m.parent === focusedBody)
          && !cities.some(c => c.body === focusedBody);
      } else if (focusedBody?.kind === 'moon') {
        navDownBtn.disabled = !cities.some(c => c.body === focusedBody);
      } else {
        navDownBtn.disabled = planets.length === 0;
      }

      let sibCount = 0;
      if (focusedCity) sibCount = cities.filter(c => c.body === focusedCity.body).length;
      else if (focusedBody?.kind === 'planet') sibCount = planets.length;
      else if (focusedBody?.kind === 'moon') {
        const m = moons.find(mn => mn.body === focusedBody);
        sibCount = moons.filter(mn => mn.parent === m?.parent).length;
      }
      navLeftBtn.disabled = navRightBtn.disabled = sibCount < 2;
    }

    if (navUpBtn) {
      navUpBtn.onclick    = navUp;
      navDownBtn.onclick  = navDown;
      navLeftBtn.onclick  = () => navSibling(-1);
      navRightBtn.onclick = () => navSibling(1);
    }

    addMoonBtn.onclick = () => {
      const parent = (focusedBody && focusedBody.kind === 'planet') ? focusedBody : planet;
      const ownCount = moons.reduce((n, m) => n + (m.parent === parent ? 1 : 0), 0);
      const defaultDistance = 18 + ownCount * 8;
      if (addMoon(parent, 1.2, defaultDistance)) {
        renderMoonsList();
        updateInfoPanel();
      }
    };

    // ---------- Renaming ----------
    // Inline edit (click the focused name in the nav) + a 🎲 button that
    // pulls from generateName(). Renaming touches a lot of surfaces — moon
    // cards, city list, info panel, nav, biome hint — so setBodyName is the
    // single fan-out point that re-renders all of them.
    function setBodyName(body, newName) {
      if (!body || !newName) return;
      body.name = newName;
      if (focusedBody === body) {
        focusNameEl.textContent = focusedCity ? `${focusedCity.name} · ${body.name}` : body.name;
      }
      renderNavBodies();
      renderMoonsList();
      renderCityList();
      updateInfoPanel();
      updateBiomeTools();
      applyFocusToLeftPanel();
    }

    function setSystemName(newName) {
      if (!newName) return;
      systemName = newName;
      renderNavBodies();
      updateInfoPanel();
    }

    function commitFocusName(newName) {
      const cleaned = newName.replace(/\s+/g, ' ').trim();
      if (!cleaned) { renderNavBodies(); return; }
      if (focusedCity) {
        focusedCity.name = cleaned;
        focusNameEl.textContent = `${cleaned} · ${focusedCity.body.name}`;
        renderNavBodies();
        renderCityList();
      } else if (focusedBody) {
        setBodyName(focusedBody, cleaned);
      } else {
        setSystemName(cleaned);
      }
    }

    navNameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); navNameEl.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); renderNavBodies(); navNameEl.blur(); }
    });
    navNameEl.addEventListener('focus', () => {
      // Select-all on focus so typing replaces the current name.
      requestAnimationFrame(() => {
        const range = document.createRange();
        range.selectNodeContents(navNameEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    });
    navNameEl.addEventListener('blur', () => {
      commitFocusName(navNameEl.textContent);
    });

    navRandomBtn.addEventListener('click', () => {
      if (focusedCity) {
        focusedCity.name = generateName('moon');
        focusNameEl.textContent = `${focusedCity.name} · ${focusedCity.body.name}`;
        renderNavBodies();
        renderCityList();
      } else if (focusedBody) {
        const kind = focusedBody.kind === 'moon' ? 'moon' : 'planet';
        setBodyName(focusedBody, generateName(kind));
      } else {
        setSystemName(generateName('system'));
      }
    });

    if (nameSourceSelect) {
      nameSourceSelect.value = nameSource;
      nameSourceSelect.addEventListener('change', () => { nameSource = nameSourceSelect.value; });
    }

    // Seed default moons from the solar system spec so Earth gets the Moon,
    // Jupiter gets its Galilean crew, etc. Names/seeds are pinned per moon.
    SOLAR_SYSTEM_SPEC.forEach((spec, i) => {
      const parent = solarBodies[i];
      spec.moons.forEach(moonSpec => {
        addMoon(parent, moonSpec.size, moonSpec.distance, {
          name: moonSpec.name,
          seed: moonSpec.seed,
        });
      });
    });
    renderMoonsList();
    updateBiomeTools();
    // Default to the system-wide view so the user sees the whole replica at
    // load — the eight planets at a glance.
    setSystemFocus();
    updateInfoPanel();

    // ---------- Resize ----------
    addEventListener('resize', () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });

    // ---------- Animate ----------
    const clock = new THREE.Clock();
    // Light updates (clock + orbit values) refresh several times per second; we
    // throttle so we're not writing DOM every single frame.
    let liveInfoAccum = 0;
    (function loop() {
      requestAnimationFrame(loop);
      const dt = clock.getDelta();
      if (!paused) {
        updatePlanetOrbits(dt);
        updatePlanetRotation(dt);
      }
      updateMoons(dt);
      updateCityMarkers();
      updateSunLightForFocus();
      updateFocusTracking();
      controls.update();
      if (isPainting && lastHitLocal && activeBrushBody) {
        applyBrushToBody(activeBrushBody, lastHitLocal, dt);
      }
      liveInfoAccum += dt;
      if (liveInfoAccum >= 0.1) { liveInfoAccum = 0; updateLiveInfo(); }
      renderer.render(scene, camera);
    })();
