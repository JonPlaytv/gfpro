import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils, VRM } from '@pixiv/three-vrm';

// Create Loading Overlay
const overlay = document.createElement('div');
overlay.className = 'loading-overlay';
overlay.innerHTML = `
  <div class="spinner"></div>
  <div class="loading-text">Waking up AI Partner...</div>
`;
document.getElementById('app')?.appendChild(overlay);

// --- Scene Setup ---
const canvas = document.getElementById('vrm-canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
// Use sRGB encoding for realistic colors (in newer three.js it's outputColorSpace)
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0.0, 1.4, 2.0); // Center roughly on a humanoid character's upper body

const controls = new OrbitControls(camera, renderer.domElement);
controls.screenSpacePanning = true;
controls.target.set(0.0, 1.4, 0.0);
controls.update();

// --- Lighting ---
const light = new THREE.DirectionalLight(0xffffff, Math.PI);
light.position.set(1.0, 1.0, 1.0).normalize();
scene.add(light);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.5); // Add soft ambient light
scene.add(ambientLight);

// --- VRM Setup ---
let currentVrm: VRM | undefined;

const loader = new GLTFLoader();

// Install GLTFLoader plugin for VRM
loader.register((parser) => {
  return new VRMLoaderPlugin(parser);
});

const vrmUrl = '/3950292976901405976.vrm'; // Fetched from public directory

loader.load(
  vrmUrl,
  (gltf) => {
    const vrm = gltf.userData.vrm as VRM;
    if (vrm) {
      // Calling these functions greatly improves the VRM rendering
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.removeUnnecessaryJoints(gltf.scene);

      scene.add(vrm.scene);
      currentVrm = vrm;
      
      // Fix rotation if character faces backwards
      vrm.scene.rotation.y = Math.PI;
      
      // Hide loading overlay
      overlay.classList.add('hidden');
      setTimeout(() => overlay.remove(), 500);

      console.log('VRM loaded successfully!');
    }
  },
  (progress) => {
    console.log('Loading model...', 100.0 * (progress.loaded / progress.total), '%');
  },
  (error) => {
    console.error('An error happened loading the VRM', error);
    overlay.innerHTML = `<div class="loading-text" style="color: #ef4444;">Error loading model. Check console.</div>`;
  }
);

// --- Animation Loop ---
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const deltaTime = clock.getDelta();

  if (currentVrm) {
    // Update VRM logic (spring bones, etc.)
    currentVrm.update(deltaTime);
  }

  renderer.render(scene, camera);
}

animate();

// --- Window Resizing ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
