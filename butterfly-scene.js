/**
 * Borboleta 3D em fundo transparente: voo orgânico + batida de asas (meshes left_wing / right_wing / body).
 * Three.js + GLTFLoader (importmap no index.html).
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_URL = new URL("./borboleta.glb", import.meta.url).href;

/** Eixo local da batida: 'x' | 'y' | 'z' — ajuste se o export do Blender mudar */
const FLAP_AXIS = "z";
const FLAP_SPEED = 0.01;
const FLAP_AMPLITUDE = 0.65;

const container = document.getElementById("canvas-container");
if (!container) {
  console.error('Elemento "#canvas-container" não encontrado.');
} else {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(0, 0.2, 4.2);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  container.innerHTML = "";
  container.appendChild(canvas);

  const ambient = new THREE.AmbientLight(0xfff5f0, 0.55);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff8e8, 1.35);
  sun.position.set(4, 8, 5);
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0xffe8cc, 0.45);
  fill.position.set(-5, 2, -4);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffd966, 0.35);
  rim.position.set(0, -3, 6);
  scene.add(rim);

  const butterfly = new THREE.Group();
  scene.add(butterfly);

  let leftWing = null;
  let rightWing = null;
  let bodyMesh = null;
  let baseLeftFlap = 0;
  let baseRightFlap = 0;

  const prevPos = new THREE.Vector3();
  const targetQuat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const velocity = new THREE.Vector3();
  const _m = new THREE.Matrix4();

  function findMeshByName(root, name) {
    const want = name.toLowerCase();
    let found = null;
    root.traverse((obj) => {
      if (obj.isMesh && obj.name && obj.name.toLowerCase() === want) found = obj;
    });
    return found;
  }

  function setWingFlapAxisRotation(mesh, base, delta) {
    if (!mesh) return;
    if (FLAP_AXIS === "x") mesh.rotation.x = base + delta;
    else if (FLAP_AXIS === "y") mesh.rotation.y = base + delta;
    else mesh.rotation.z = base + delta;
  }

  function readWingFlapAxis(mesh) {
    if (!mesh) return 0;
    if (FLAP_AXIS === "x") return mesh.rotation.x;
    if (FLAP_AXIS === "y") return mesh.rotation.y;
    return mesh.rotation.z;
  }

  new GLTFLoader().load(
    MODEL_URL,
    (gltf) => {
      const root = gltf.scene;
      butterfly.add(root);

      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      root.position.sub(center);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
      const scale = 1.6 / maxDim;
      root.scale.setScalar(scale);

      leftWing = findMeshByName(root, "left_wing");
      rightWing = findMeshByName(root, "right_wing");
      bodyMesh = findMeshByName(root, "body");

      if (!leftWing || !rightWing) {
        console.warn(
          "[butterfly-scene] Procure meshes nomeados left_wing e right_wing no Blender antes do export GLB."
        );
      }
      baseLeftFlap = readWingFlapAxis(leftWing);
      baseRightFlap = readWingFlapAxis(rightWing);

      if (bodyMesh) bodyMesh.frustumCulled = true;
    },
    undefined,
    (err) => {
      console.error("[butterfly-scene] Falha ao carregar borboleta.glb:", err);
    }
  );

  const flightTimeScale = 0.00038;
  let lastT = performance.now();
  let tiltReady = false;

  const loopCurve = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-1.1, 0.35, 0.15),
      new THREE.Vector3(-0.35, -0.55, -0.12),
      new THREE.Vector3(0.9, 0.2, 0.22),
      new THREE.Vector3(0.25, 0.75, -0.18),
      new THREE.Vector3(-0.8, -0.15, 0.08),
    ],
    true,
    "catmullrom",
    0.45
  );

  function sampleFlightPosition(timeMs, out) {
    const t = timeMs * flightTimeScale;
    out.x =
      Math.sin(t * 1.05) * 1.35 +
      Math.sin(t * 2.41 + 1.2) * 0.28 +
      Math.cos(t * 0.73) * 0.15;
    out.y =
      Math.cos(t * 0.88) * 0.75 +
      Math.sin(t * 1.63 + 0.4) * 0.22 +
      Math.sin(t * 3.1) * 0.08;
    out.z =
      Math.sin(t * 0.62) * 0.42 +
      Math.cos(t * 1.9 + 2.1) * 0.12;

    const u = (t * 0.22) % 1;
    const c = loopCurve.getPoint(u);
    out.x += c.x * 0.28;
    out.y += c.y * 0.22;
    out.z += c.z * 0.35;
    return out;
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener("resize", onResize);

  function animate(now) {
    requestAnimationFrame(animate);

    const dtSec = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;

    sampleFlightPosition(now, butterfly.position);

    if (!tiltReady) {
      prevPos.copy(butterfly.position);
      tiltReady = true;
    } else {
      velocity.subVectors(butterfly.position, prevPos);
      prevPos.copy(butterfly.position);
      if (dtSec > 1e-6 && velocity.lengthSq() > 1e-10) {
        velocity.divideScalar(dtSec);
        const dir = velocity.clone().normalize();
        const lookTarget = butterfly.position.clone().add(dir);
        _m.lookAt(butterfly.position, lookTarget, up);
        targetQuat.setFromRotationMatrix(_m);
        butterfly.quaternion.slerp(targetQuat, 0.1);
      }
    }

    const flap = Math.sin(now * FLAP_SPEED) * FLAP_AMPLITUDE;
    setWingFlapAxisRotation(leftWing, baseLeftFlap, flap);
    setWingFlapAxisRotation(rightWing, baseRightFlap, -flap);

    renderer.render(scene, camera);
  }

  requestAnimationFrame(animate);
}
