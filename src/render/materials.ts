import * as THREE from 'three';

/** Procedural clay matcap (grayscale, so the material color tints it). No image asset needed. */
export function makeMatcap(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const L1 = new THREE.Vector3(-0.45, 0.6, 0.66).normalize(); // key, upper left
  const L2 = new THREE.Vector3(0.7, -0.2, 0.4).normalize(); // fill, right
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1, ny = -((y / (size - 1)) * 2 - 1);
      const r2 = nx * nx + ny * ny;
      const o = (y * size + x) * 4;
      if (r2 > 1) {
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 60;
        img.data[o + 3] = 255;
        continue;
      }
      const nz = Math.sqrt(1 - r2);
      const n = new THREE.Vector3(nx, ny, nz);
      const d1 = Math.max(0, n.dot(L1)), d2 = Math.max(0, n.dot(L2));
      const h = new THREE.Vector3().addVectors(L1, new THREE.Vector3(0, 0, 1)).normalize();
      const spec = Math.pow(Math.max(0, n.dot(h)), 48) * 0.22;
      const rim = Math.pow(1 - nz, 3) * 0.18;
      const v = Math.min(1, 0.2 + d1 * 0.68 + d2 * 0.16 + spec + rim);
      const c = Math.round(Math.pow(v, 1 / 1.15) * 255);
      img.data[o] = img.data[o + 1] = img.data[o + 2] = c;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Screen-space constant-width outline drawn from back faces pushed out along normals. */
export function makeOutlineMaterial(color: number, widthPx: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(color) },
      thickness: { value: widthPx },
      resolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      uniform float thickness;
      uniform vec2 resolution;
      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vec2 dir = (projectionMatrix * vec4(n, 0.0)).xy;
        float l = length(dir);
        if (l > 1e-6) clip.xy += dir / l * thickness / resolution * 2.0 * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      void main() { gl_FragColor = vec4(color, 1.0); }`,
    side: THREE.BackSide,
  });
}

/** Round screen-space dots with per-vertex color and size (CSS px). */
export function makePointMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: 1 }, bias: { value: 0.004 } },
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute float psize;
      uniform float pixelRatio;
      uniform float bias;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // Pull the dot slightly towards the camera (relative to its distance) so it wins
        // against the surface it sits on, without showing through geometry in front of it.
        mv.z += bias * max(-mv.z, 0.01);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = psize * pixelRatio;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        vec3 col = d > 0.36 ? vec3(0.05) : vColor;
        gl_FragColor = vec4(col, 1.0);
      }`,
    transparent: false,
  });
}

export const COLORS = {
  background: 0x2a2c31,
  gridMajor: 0x3d4048,
  gridMinor: 0x34363d,
  axisX: 0xd9485c,
  axisY: 0x7fbf3f,
  axisZ: 0x3f7fdf,
  selected: 0xff9a2e,
  active: 0xffd27a,
  edge: 0x101114,
  vert: 0x16171a,
  vertSel: 0xffa33a,
  edgeSel: 0xffa33a,
  faceTint: 0xff8a1f,
};
