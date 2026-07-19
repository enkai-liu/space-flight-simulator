import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Clamps the HDR frame before bloom. GGX speculars at grazing incidence
 * (e.g. the ocean glint seen edge-on from the launch site) overflow the
 * half-float target to inf, and a single non-finite pixel NaN-poisons the
 * bloom blur into a giant black rectangle. min() maps inf down to the cap;
 * the comparison guards catch NaN (any comparison with NaN is false).
 */
const SanitizeShader = {
  uniforms: {
    tDiffuse: { value: null },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 v = min(max(c.rgb, vec3(0.0)), vec3(48.0));
      if (!(v.r >= 0.0)) v.r = 0.0;
      if (!(v.g >= 0.0)) v.g = 0.0;
      if (!(v.b >= 0.0)) v.b = 0.0;
      gl_FragColor = vec4(v, c.a);
    }
  `,
};

/**
 * Bloom pipeline for the flight scene. The threshold sits at 1.0 so only
 * deliberately-HDR colors (sun, engine plumes, bright stars) bloom — everything
 * else renders identically to the direct path. Disable with ?nofx.
 */
export class PostFX {
  private readonly composer: EffectComposer;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly bloom: UnrealBloomPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    // antialias:true only covers the default framebuffer; the composer needs
    // its own multisampled HDR target or every edge re-aliases
    this.target = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
      samples: 4,
      type: THREE.HalfFloatType,
    });
    this.composer = new EffectComposer(renderer, this.target);
    this.composer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(new ShaderPass(SanitizeShader));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.4, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  render(): void {
    this.composer.render();
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }

  dispose(): void {
    this.composer.dispose();
    this.bloom.dispose();
    this.target.dispose();
  }
}
