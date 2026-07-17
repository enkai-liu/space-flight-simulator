import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

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
