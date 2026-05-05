/**
 * Cena 3D: splash com voo errático, transição até o monograma e pouso — batida orgânica + lookAt na velocidade.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const CONFIG = {
  modelUrl: new URL("./borboleta.glb", import.meta.url).href,
  transitionMs: 5200,
  /** Amplitude da batida (rad) — ossos costumam precisar um pouco mais */
  flapAngle: 0.55,
  landDistance: 2.05,
  landScaleFactor: 0.14,
  /** Arco vertical único (sobe e desce suave); valores menores evitam “sumir” no topo */
  flightArcHeight: 0.38,
  /** Desvio em X (mundo): direita → esquerda → centro ao longo do voo */
  flightSwayWidth: 0.32,
  /** Escala base do GLB após normalizar (maior = borboleta maior no splash) */
  modelFitScale: 0.92,
  /**
   * Mesh único: só escala (eixo X “abre” asas) — sem rotação para não balançar.
   * Intensidade extra no pico (0–1).
   */
  fusedFlapSpread: 0.2,
  fusedFlapPeakBoost: 1.25,
  /** Meshes left_wing / right_wing: eixo da dobradiça ('x'|'y'|'z') — se asas parecerem “de pé”, teste 'y' ou 'z' */
  namedWingAxis: "y",
  /** Abertura máx. (rad) nas asas nomeadas (sinal orgânico escala ±1 → ±rad) */
  namedWingFlapMaxRad: 0.48,
  /** Amplitude vertical do corpo (splash — valores baixos = menos “tremida”) */
  organicBodyBob: 0.011,
  /** Bob vertical no A (mesma lógica do splash, escala própria) */
  organicBodyBobLanded: 0.014,
  /** Amplitudes do vagar no splash (mundo) — subtis */
  wanderSplashX: 0.038,
  wanderSplashY: 0.026,
  wanderSplashZ: 0.02,
  /** Suavização do vagar no splash (1/s, tipo low-pass) */
  splashWanderSmoothing: 3.8,
  /** Suavização do sinal de asas: splash e pouso no A (1/s) */
  splashFlapSmoothing: 7.2,
  /** Intensidade extra de errância no voo (some ao longo do t) */
  transitionWanderMix: 0.34,
  /** Suavização da orientação para a velocidade (1/s) */
  orientationSlerpLambda: 7.5,
  /** Frequências orgânicas (rad/s) */
  organicFlapFast: 11.2,
  organicFlapSlow: 1.75,
  organicFlapWobble: 3.6,
  organicGlideSharpness: 1.08,
  /** Ajuste fino se o nariz do GLB não aponta para −Z após lookAt (rad, eixo Y local) */
  organicHeadingYawOffset: 0,
  /**
   * Rotação inicial (rad) do grupo — “de frente” para a câmera (Y gira o nariz/corpo para a tela).
   * Se ainda vir de perfil, mexa principalmente em splashEulerY (passos de ~π/4).
   */
  splashEulerX: -0.48,
  splashEulerY: Math.PI / 2 + 0.12,
  splashEulerZ: 0.04,
  /** Pouso no A: mesma “frente” aproximada, leve inclinação para combinar com o monograma */
  landEulerX: -0.38,
  landEulerY: Math.PI / 2 + 0.08,
  landEulerZ: 0.03,
};

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const _ndc = new THREE.Vector2();
const _straight = new THREE.Vector3();
const _nextPos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _wander = new THREE.Vector3();
const _smoothVel = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _orientScratch = new THREE.Object3D();
const splashRestPos = new THREE.Vector3();
const splashBaseQuat = new THREE.Quaternion();
const prevButterflyPos = new THREE.Vector3();
/** Filtro passa-baixa: splash mais estável */
const splashWanderSmoothed = new THREE.Vector3();
let splashFlapSmoothed = 0;
/** Mesmo filtro de asas do splash, usado no pouso */
let landedFlapSmoothed = 0;

let scene;
let camera;
let renderer;
let butterflyRoot;
let butterflyMeshes = [];
let mixer = null;
let clock;
let flapAction = null;

/** @type {'splash' | 'transition' | 'landed'} */
let phase = "splash";
let transitionStart = 0;
let splashPos = new THREE.Vector3();
let splashQuat = new THREE.Quaternion();
let splashScale = 1;
let landPos = new THREE.Vector3();
/** Alvo do pouso fixado no clique (evita “tranco” quando o convite entra e o âncora se move) */
const landPosFrozen = new THREE.Vector3();
let landQuat = new THREE.Quaternion();
let landScale = 1;
let landPosDirty = false;

/** @type {THREE.Object3D | null} */
let leftWing = null;
/** @type {THREE.Object3D | null} */
let rightWing = null;
let baseLeft = 0;
let baseRight = 0;
/** 'x' | 'y' | 'z' — eixo local usado na batida */
let flapAxis = "z";

/** Primeiro filho do root = cena do GLB (mesh único sem rig) */
let innerModel = null;
const baseInnerScale = new THREE.Vector3(1, 1, 1);

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}

function smoothstep01(t) {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * Posição no voo: reta suave + arco vertical + onda em S no eixo X mundial.
 * @param {number} ePos Parâmetro 0–1 (ex.: smoothstep do tempo).
 * @param {THREE.Vector3} out Vetor de saída.
 */
function getFlightPositionAtEPos(ePos, out) {
  out.copy(splashPos).lerp(landPosFrozen, ePos);
  out.y += Math.sin(Math.PI * ePos) * CONFIG.flightArcHeight;
  out.x += Math.sin(2 * Math.PI * ePos) * CONFIG.flightSwayWidth;
  return out;
}

/**
 * Sinal de batida orgânico (−1…1): produto de senos + janela de “glide”.
 * @param {number} tSec Tempo contínuo em segundos.
 */
function organicFlapSignal(tSec) {
  const ph1 = tSec * CONFIG.organicFlapFast;
  const ph2 = tSec * CONFIG.organicFlapSlow;
  const ph3 = tSec * CONFIG.organicFlapWobble;
  const flutter = Math.sin(ph1) * (0.4 + 0.6 * Math.cos(ph2));
  const burst = Math.sin(ph1 * 1.65 + Math.sin(ph3) * 0.55) * 0.14;
  const glideWindow = Math.pow(Math.abs(Math.cos(ph2 * CONFIG.organicGlideSharpness)), 2);
  const intensity = 0.5 + 0.5 * glideWindow;
  return THREE.MathUtils.clamp(flutter * intensity + burst, -1, 1);
}

/**
 * Batida um pouco mais calma na tela inicial (menos picos bruscos).
 * @param {number} tSec
 */
function organicFlapSignalSplash(tSec) {
  const s = organicFlapSignal(tSec * 0.88);
  return s * 0.82;
}

/**
 * Deslocamento errático no splash (combina várias frequências em X, Y, Z).
 * @param {number} tSec
 * @param {THREE.Vector3} out
 */
function wanderSplashOffset(tSec, out) {
  const ax = CONFIG.wanderSplashX;
  const ay = CONFIG.wanderSplashY;
  const az = CONFIG.wanderSplashZ;
  /* Frequências mais baixas = movimento mais “respirado”, menos nervoso */
  out.x = Math.sin(tSec * 0.31) * Math.cos(tSec * 0.13) * ax;
  out.y = Math.cos(tSec * 0.24) * Math.sin(tSec * 0.19) * ay;
  out.z = Math.sin(tSec * 0.22 + 0.7) * Math.cos(tSec * 0.11) * az;
  return out;
}

/**
 * Errância extra durante o voo (atenua com o progresso da transição).
 * @param {number} tSec
 * @param {number} rawT 0…1 progresso bruto da transição
 * @param {THREE.Vector3} out
 */
function wanderTransitionOffset(tSec, rawT, out) {
  const fade = (1 - smoothstep01(rawT)) * CONFIG.transitionWanderMix;
  out.x = Math.sin(tSec * 0.48) * Math.cos(tSec * 0.17 + rawT) * 0.14 * fade;
  out.y = Math.cos(tSec * 0.35) * Math.sin(tSec * 0.27) * 0.09 * fade;
  out.z = Math.sin(tSec * 0.41 + 0.4) * 0.065 * fade;
  return out;
}

/**
 * Atualiza velocidade suavizada e grava a posição deste frame para o próximo delta.
 * @param {number} dt Delta em segundos.
 */
function finalizeFrameVelocity(dt) {
  _vel.subVectors(butterflyRoot.position, prevButterflyPos);
  _vel.multiplyScalar(1 / Math.max(dt, 1e-4));
  const snap = 1 - Math.exp(-14 * dt);
  _smoothVel.lerp(_vel, snap);
  prevButterflyPos.copy(butterflyRoot.position);
}

/**
 * Orienta o grupo na direção do movimento (lookAt suavizado em cima da velocidade).
 * @param {number} dt
 * @param {THREE.Quaternion} fallbackQuat Quando a velocidade é quase nula.
 * @param {number} fallbackBlend 0…1 quanto misturar o fallback quando lento.
 */
function orientTowardVelocity(dt, fallbackQuat, fallbackBlend) {
  const speed = _smoothVel.length();
  const minSpeed = 0.014;
  if (speed < minSpeed) {
    if (fallbackBlend > 0) {
      const t = 1 - speed / minSpeed;
      butterflyRoot.quaternion.slerp(fallbackQuat, fallbackBlend * THREE.MathUtils.clamp(t, 0, 1));
    }
    return;
  }
  _lookTarget.copy(butterflyRoot.position).addScaledVector(_smoothVel, 0.24 / speed);
  _orientScratch.position.copy(butterflyRoot.position);
  _orientScratch.quaternion.identity();
  _orientScratch.up.set(0, 1, 0);
  _orientScratch.lookAt(_lookTarget);
  if (CONFIG.organicHeadingYawOffset !== 0) {
    _orientScratch.rotateY(CONFIG.organicHeadingYawOffset);
  }
  const align = 1 - Math.exp(-CONFIG.orientationSlerpLambda * dt);
  butterflyRoot.quaternion.slerp(_orientScratch.quaternion, align);
}

/**
 * Aplica rotação das asas a partir do sinal orgânico (−1…1).
 * @param {number} signal
 */
function applyOrganicWingFlap(signal) {
  if (leftWing || rightWing) {
    const maxRad = isNamedWingPair() ? CONFIG.namedWingFlapMaxRad : CONFIG.flapAngle;
    const a = signal * maxRad;
    if (leftWing) writeFlapRotation(leftWing, baseLeft + a);
    if (rightWing) writeFlapRotation(rightWing, baseRight - a);
    if (leftWing && !rightWing) writeFlapRotation(leftWing, baseLeft + a * 0.5);
    return;
  }
  const w = THREE.MathUtils.clamp((signal + 1) * 0.5, 0, 1);
  applyFusedMeshFlap(w);
}

function getAnchorClientCenter() {
  const el = document.getElementById("butterfly-anchor");
  if (!el) return { x: innerWidth / 2, y: innerHeight * 0.28 };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function worldPointAlongViewRay(clientX, clientY, distance) {
  _ndc.x = (clientX / innerWidth) * 2 - 1;
  _ndc.y = -(clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(_ndc, camera);
  const dir = raycaster.ray.direction.clone().normalize();
  return camera.position.clone().add(dir.multiplyScalar(distance));
}

function updateLandTarget() {
  const { x, y } = getAnchorClientCenter();
  landPos.copy(worldPointAlongViewRay(x, y, CONFIG.landDistance));
}

function collectMeshes(root, out) {
  root.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = false;
      child.receiveShadow = false;
      out.push(child);
    }
  });
}

function nameMatchesWingLeft(n) {
  return (
    /left|esquer|l_wing|wing_l|wing0|fore.*l|hind.*l|_l\b|\.l\b|^l$/i.test(n) &&
    !/light|highlight/i.test(n)
  );
}

function nameMatchesWingRight(n) {
  return (
    /right|direit|r_wing|wing_r|wing1|fore.*r|hind.*r|_r\b|\.r\b|^r$/i.test(n) &&
    !/light|highlight/i.test(n)
  );
}

function nameMatchesWingGeneric(n) {
  return /wing|asa|wings|al[ae]|flutter/i.test(n) && !/body|corpo|thorax|abdomen|head|borboleta/i.test(n);
}

function findMeshByNameCI(root, want) {
  const w = want.toLowerCase();
  let found = null;
  root.traverse((obj) => {
    if (obj.isMesh && obj.name && obj.name.toLowerCase() === w) found = obj;
  });
  return found;
}

function isNamedWingPair() {
  return (
    leftWing &&
    rightWing &&
    /left_wing/i.test(leftWing.name) &&
    /right_wing/i.test(rightWing.name)
  );
}

/**
 * Encontra ossos de asa (SkinnedMesh) ou meshes separados.
 * @returns {{ left: THREE.Object3D | null, right: THREE.Object3D | null, axis: 'x' | 'y' | 'z' }}
 */
function findWingTargets(root) {
  const lw = findMeshByNameCI(root, "left_wing");
  const rw = findMeshByNameCI(root, "right_wing");
  if (lw && rw) {
    return {
      left: lw,
      right: rw,
      axis: CONFIG.namedWingAxis,
    };
  }

  const boneLeft = [];
  const boneRight = [];
  root.traverse((child) => {
    if (!child.isSkinnedMesh || !child.skeleton) return;
    for (const bone of child.skeleton.bones) {
      const n = bone.name.toLowerCase();
      if (nameMatchesWingLeft(n)) boneLeft.push(bone);
      else if (nameMatchesWingRight(n)) boneRight.push(bone);
      else if (nameMatchesWingGeneric(n)) {
        if (boneLeft.length <= boneRight.length) boneLeft.push(bone);
        else boneRight.push(bone);
      }
    }
  });
  if (boneLeft.length && boneRight.length) {
    return { left: boneLeft[0], right: boneRight[0], axis: "x" };
  }

  const allWingBones = [];
  const _p = new THREE.Vector3();
  const _q = new THREE.Vector3();
  root.traverse((child) => {
    if (child.isBone && child.name && nameMatchesWingGeneric(child.name.toLowerCase())) {
      allWingBones.push(child);
    }
  });
  if (allWingBones.length >= 2) {
    allWingBones.sort((a, b) => {
      a.getWorldPosition(_p);
      b.getWorldPosition(_q);
      return _p.x - _q.x;
    });
    return {
      left: allWingBones[0],
      right: allWingBones[allWingBones.length - 1],
      axis: "x",
    };
  }

  const meshLeft = [];
  const meshRight = [];
  root.traverse((child) => {
    if (!child.isMesh || !child.name) return;
    const n = child.name.toLowerCase();
    if (nameMatchesWingLeft(n)) meshLeft.push(child);
    else if (nameMatchesWingRight(n)) meshRight.push(child);
  });
  if (meshLeft.length && meshRight.length) {
    return { left: meshLeft[0], right: meshRight[0], axis: "z" };
  }

  return { left: null, right: null, axis: "z" };
}

function readFlapRotation(obj) {
  if (!obj) return 0;
  if (flapAxis === "x") return obj.rotation.x;
  if (flapAxis === "y") return obj.rotation.y;
  return obj.rotation.z;
}

function writeFlapRotation(obj, value) {
  if (!obj) return;
  if (flapAxis === "x") obj.rotation.x = value;
  else if (flapAxis === "y") obj.rotation.y = value;
  else obj.rotation.z = value;
}

/**
 * GLB “sólido” (uma malha): simula batida alargando levemente no X e compensando Y/Z.
 * @param {number} amount Intensidade 0–1 (pico da batida).
 */
function applyFusedMeshFlap(amount) {
  if (!innerModel) return;
  let w = THREE.MathUtils.clamp(amount, 0, 1);
  w = Math.min(1, w * CONFIG.fusedFlapPeakBoost);
  const s = CONFIG.fusedFlapSpread * w;
  /* Só escala: alarga no X (batida), leve ajuste Y/Z sem inclinar o corpo */
  innerModel.scale.set(
    baseInnerScale.x * (1 + s * 1.35),
    baseInnerScale.y * (1 - s * 0.32),
    baseInnerScale.z * (1 - s * 0.28)
  );
}

function resetFusedMeshVisual() {
  if (!innerModel) return;
  innerModel.scale.copy(baseInnerScale);
}

function resetFlapBases() {
  if (leftWing) baseLeft = readFlapRotation(leftWing);
  if (rightWing) baseRight = readFlapRotation(rightWing);
  if (!leftWing && !rightWing) resetFusedMeshVisual();
}

function onPointerDown(event) {
  if (phase !== "splash") return;
  const canvas = document.getElementById("webgl-canvas");
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(butterflyMeshes, true);
  if (hits.length === 0) return;

  phase = "transition";
  transitionStart = performance.now();

  splashPos.copy(butterflyRoot.position);
  splashQuat.copy(butterflyRoot.quaternion);
  splashScale = butterflyRoot.scale.x;

  updateLandTarget();
  landPosFrozen.copy(landPos);

  landQuat.setFromEuler(
    new THREE.Euler(CONFIG.landEulerX, CONFIG.landEulerY, CONFIG.landEulerZ, "YXZ")
  );
  landScale = splashScale * CONFIG.landScaleFactor;

  _smoothVel.set(0, 0, 0);
  prevButterflyPos.copy(butterflyRoot.position);

  document.getElementById("splash-cta")?.setAttribute("hidden", "true");
  window.dispatchEvent(new CustomEvent("invite:music"));
}

function finishTransition() {
  phase = "landed";
  landPos.copy(landPosFrozen);
  butterflyRoot.position.copy(landPosFrozen);
  butterflyRoot.quaternion.copy(landQuat);
  butterflyRoot.scale.setScalar(landScale);
  document.body.classList.remove("state-splash");
  document.body.classList.add("state-invite");
  document.getElementById("splash-ui")?.setAttribute("aria-hidden", "true");
  const shell = document.getElementById("invite-shell");
  shell?.classList.remove("invite-shell--entering");
  shell?.classList.add("invite-shell--visible");
  resetFlapBases();
  landedFlapSmoothed = organicFlapSignalSplash(performance.now() * 0.001);
  prevButterflyPos.copy(landPosFrozen);
  _smoothVel.set(0, 0, 0);
  landPosDirty = true;
  if (mixer && flapAction) {
    flapAction.setLoop(THREE.LoopRepeat, Infinity);
    flapAction.reset();
    flapAction.play();
  }
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(clock.getDelta(), 0.08);
  const tSec = now * 0.001;

  if (!renderer || !scene || !camera) return;

  if (phase === "splash" && butterflyMeshes.length > 0) {
    const sigRaw = organicFlapSignalSplash(tSec);
    const flapAlpha = 1 - Math.exp(-CONFIG.splashFlapSmoothing * dt);
    splashFlapSmoothed += (sigRaw - splashFlapSmoothed) * flapAlpha;

    wanderSplashOffset(tSec, _wander);
    const wanderAlpha = 1 - Math.exp(-CONFIG.splashWanderSmoothing * dt);
    splashWanderSmoothed.lerp(_wander, wanderAlpha);

    const bob = -splashFlapSmoothed * CONFIG.organicBodyBob;
    const bobHarm =
      Math.sin(tSec * CONFIG.organicFlapFast * 1.15) * CONFIG.organicBodyBob * 0.06;

    _straight.copy(splashRestPos).add(splashWanderSmoothed);
    _straight.y += bob + bobHarm;
    butterflyRoot.position.copy(_straight);

    butterflyRoot.quaternion.copy(splashBaseQuat);
    applyOrganicWingFlap(splashFlapSmoothed);
  } else if (phase === "transition") {
    const rawT = Math.min(1, (now - transitionStart) / CONFIG.transitionMs);
    const e = easeInOutCubic(rawT);
    const ePos = smoothstep01(rawT);

    getFlightPositionAtEPos(ePos, _straight);
    wanderTransitionOffset(tSec, rawT, _wander);
    _straight.add(_wander);

    const sig = organicFlapSignal(tSec);
    _straight.y += (-sig * CONFIG.organicBodyBob) * 0.7;

    butterflyRoot.position.copy(_straight);

    finalizeFrameVelocity(dt);

    _tmpQuat.slerpQuaternions(splashQuat, landQuat, e);
    orientTowardVelocity(dt, _tmpQuat, 0.12 + 0.28 * (1 - rawT));
    const settle = smoothstep01(Math.max(0, (rawT - 0.7) / 0.3));
    butterflyRoot.quaternion.slerp(landQuat, settle * 0.82);

    butterflyRoot.scale.setScalar(THREE.MathUtils.lerp(splashScale, landScale, e));
    applyOrganicWingFlap(sig);

    if (rawT > 0.22) {
      const shell = document.getElementById("invite-shell");
      shell?.classList.remove("invite-shell--entering");
      shell?.classList.add("invite-shell--visible");
    }
    if (rawT >= 1) {
      resetFusedMeshVisual();
      resetFlapBases();
      finishTransition();
    }
  } else if (phase === "landed") {
    if (landPosDirty) {
      updateLandTarget();
      butterflyRoot.position.copy(landPos);
      landPosDirty = false;
    }

    const sigRaw = organicFlapSignalSplash(tSec);
    const flapAlpha = 1 - Math.exp(-CONFIG.splashFlapSmoothing * dt);
    landedFlapSmoothed += (sigRaw - landedFlapSmoothed) * flapAlpha;

    const bob = -landedFlapSmoothed * CONFIG.organicBodyBobLanded;
    const bobHarm =
      Math.sin(tSec * CONFIG.organicFlapFast * 1.15) * CONFIG.organicBodyBobLanded * 0.06;

    if (mixer && flapAction) {
      mixer.update(dt);
      if (!flapAction.isRunning()) {
        flapAction.reset();
        flapAction.play();
      }
    } else {
      applyOrganicWingFlap(landedFlapSmoothed);
    }
    butterflyRoot.position.set(landPos.x, landPos.y + bob + bobHarm, landPos.z);
    butterflyRoot.quaternion.copy(landQuat);
    prevButterflyPos.copy(butterflyRoot.position);
  }

  renderer.render(scene, camera);
}

function centerButterflyPivotOnce() {
  if (!butterflyRoot) return;
  butterflyRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(butterflyRoot);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  butterflyRoot.position.sub(c);
}

function updateSplashCamera() {
  if (!camera || !butterflyRoot) return;
  butterflyRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(butterflyRoot);
  if (box.isEmpty()) return;
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const r = Math.max(sphere.radius, 0.02);
  const dist = r * 2.5;
  camera.position.set(0, r * 0.1 + 0.2, dist);
  camera.near = Math.max(0.02, dist * 0.015);
  camera.far = dist * 5 + 30;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
}

/** Corrige desvio em X/Y na tela após o bounding box (convite / UI pode empurrar percepção) */
function nudgeButterflyToScreenCenter() {
  if (!butterflyRoot || !camera) return;
  butterflyRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(butterflyRoot);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const ndc = center.clone().project(camera);
  if (Math.abs(ndc.x) < 0.008 && Math.abs(ndc.y) < 0.01) return;
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), camDir);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  else right.normalize();
  const up = new THREE.Vector3().crossVectors(camDir, right).normalize();
  butterflyRoot.position.addScaledVector(right, -ndc.x * 0.68);
  butterflyRoot.position.addScaledVector(up, -ndc.y * 0.55);
}

function onResize() {
  if (!camera || !renderer) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  if (phase === "splash") {
    updateSplashCamera();
    nudgeButterflyToScreenCenter();
    splashRestPos.copy(butterflyRoot.position);
    splashWanderSmoothed.set(0, 0, 0);
  }
  if (phase === "landed") landPosDirty = true;
}

function initThree() {
  const canvas = document.getElementById("webgl-canvas");
  scene = new THREE.Scene();
  clock = new THREE.Clock();

  camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 100);
  camera.position.set(0, 0.35, 2.2);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  /* ACES escurece muito modelos claros; Linear + exposição deixa próximo do preview do GLB */
  renderer.toneMapping = THREE.LinearToneMapping;
  renderer.toneMappingExposure = 1.35;

  const hemi = new THREE.HemisphereLight(0xffffff, 0xc9b8e8, 1.15);
  scene.add(hemi);

  scene.add(new THREE.AmbientLight(0xfff8ff, 0.65));

  const key = new THREE.DirectionalLight(0xffffff, 1.85);
  key.position.set(3.5, 6.5, 4);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xf0e8ff, 1.1);
  fill.position.set(-4, 2.5, -3);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffeef8, 0.75);
  rim.position.set(0, -2, 5);
  scene.add(rim);

  butterflyRoot = new THREE.Group();
  scene.add(butterflyRoot);

  window.addEventListener("resize", onResize);
  canvas.addEventListener("pointerdown", onPointerDown);
}

function setSplashPose() {
  butterflyRoot.position.set(0, 0, 0);
  butterflyRoot.scale.setScalar(1);
  butterflyRoot.rotation.set(
    CONFIG.splashEulerX,
    CONFIG.splashEulerY,
    CONFIG.splashEulerZ,
    "YXZ"
  );
  splashBaseQuat.copy(butterflyRoot.quaternion);
}

function loadModel() {
  const loader = new GLTFLoader();
  const loadingEl = document.getElementById("splash-loading");
  const ctaEl = document.getElementById("splash-cta");

  loader.load(
    CONFIG.modelUrl,
    (gltf) => {
      const model = gltf.scene;
      butterflyMeshes.length = 0;
      collectMeshes(model, butterflyMeshes);

      model.traverse((child) => {
        if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of mats) {
            if (m.emissive) {
              if (m.emissive.getHex() === 0) m.emissive.setHex(0x2a2838);
              m.emissiveIntensity = Math.min(0.42, Math.max(m.emissiveIntensity || 0, 0.14));
            }
          }
        }
      });

      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.001);
      model.scale.setScalar(CONFIG.modelFitScale / maxDim);
      butterflyRoot.add(model);
      model.updateMatrixWorld(true);

      setSplashPose();
      centerButterflyPivotOnce();
      updateSplashCamera();
      nudgeButterflyToScreenCenter();
      splashRestPos.copy(butterflyRoot.position);
      prevButterflyPos.copy(butterflyRoot.position);
      _smoothVel.set(0, 0, 0);
      splashFlapSmoothed = 0;
      landedFlapSmoothed = 0;
      splashWanderSmoothed.set(0, 0, 0);

      const wings = findWingTargets(model);
      leftWing = wings.left;
      rightWing = wings.right;
      flapAxis = wings.axis;
      resetFlapBases();

      /* Pulso “fused” só quando não há asas separadas (evita deformar o GLB inteiro) */
      innerModel = leftWing || rightWing ? null : model;
      if (innerModel) baseInnerScale.copy(model.scale);

      const clip0 = gltf.animations?.[0];
      if (
        clip0 &&
        clip0.duration > 0.05 &&
        clip0.duration < 2.2 &&
        !leftWing &&
        !rightWing &&
        innerModel
      ) {
        mixer = new THREE.AnimationMixer(model);
        flapAction = mixer.clipAction(clip0);
        flapAction.setLoop(THREE.LoopRepeat, Infinity);
      }

      if (loadingEl) loadingEl.hidden = true;
      if (ctaEl) ctaEl.removeAttribute("hidden");
    },
    undefined,
    (err) => {
      console.error("GLB:", err);
      if (loadingEl) {
        loadingEl.textContent = "Não foi possível carregar a borboleta. Abrindo o convite…";
      }
      setTimeout(() => {
        document.body.classList.remove("state-splash");
        document.body.classList.add("state-invite");
        document.getElementById("invite-shell")?.classList.remove("invite-shell--entering");
        document.getElementById("invite-shell")?.classList.add("invite-shell--visible");
        document.getElementById("splash-ui")?.remove();
        document.getElementById("canvas-container")?.remove();
      }, 2200);
    }
  );
}

initThree();
loadModel();
requestAnimationFrame(animate);
