import * as THREE from 'three';

/**
 * Star field: a fixed sphere of points around the camera. Since the camera
 * always sits at the scene origin (floating origin), the points never move.
 */
export function createStarfield(count = 2500): THREE.Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const radius = 5e12; // far beyond everything; log depth buffer copes

  // deterministic layout — same sky every load
  let s = 42;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    // uniform direction on the sphere
    const z = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const xy = Math.sqrt(1 - z * z);
    positions[i * 3] = radius * xy * Math.cos(phi);
    positions[i * 3 + 1] = radius * xy * Math.sin(phi);
    positions[i * 3 + 2] = radius * z;

    const brightness = 0.4 + rand() * 0.6;
    const warmth = rand();
    colors[i * 3] = brightness;
    colors[i * 3 + 1] = brightness * (0.85 + 0.15 * warmth);
    colors[i * 3 + 2] = brightness * (0.8 + 0.2 * (1 - warmth));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 2.2,
    sizeAttenuation: false,
    vertexColors: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return points;
}
