/**
 * flying mom - Kim Crew Swimming Mascot & Physics Module
 * 
 * Creates 2 autonomous Kim Crew puppies (kc-stay.png) swimming freely
 * across the screen like in a pool, with:
 * - Fluid autonomous swimming (smooth wandering curves, doggy paddle bob, directional facing)
 * - Soft edge boundary steering
 * - Grab & Drag with dynamic torque tilt
 * - Fling / Toss physics with screen wall bounce & restitution
 * - Mutual 2D elastic collision (bouncing off each other, trajectory deflection, spin & squash)
 * - Seamless transition from fast fling deceleration back into gentle cruising
 */

import { getCurrentThemeConfig, onThemeChange } from './theme.js';

let swimmers = [];
let swimmingRafId = null;

class SwimmingKimCrew {
  constructor(id, startX, startY, startHeading) {
    this.id = id;
    this.width = 50;
    this.height = 58;

    // Position & Velocity
    this.x = startX;
    this.y = startY;
    this.vx = Math.cos(startHeading) * 1.15;
    this.vy = Math.sin(startHeading) * 1.15;
    this.heading = startHeading;
    this.wanderAngle = (Math.random() - 0.5) * Math.PI;

    // Motion states: 'swimming', 'dragging', 'flying'
    this.state = 'swimming';
    this.swimTime = Math.random() * 200;
    this.facing = this.vx >= 0 ? 1 : -1;
    this.facingScale = this.facing;

    // Interaction tracking
    this.pointerId = null;
    this.grabOffsetX = 0;
    this.grabOffsetY = 0;
    this.leverX = 0;
    this.leverY = 0;
    this.dragVx = 0;
    this.dragVy = 0;
    this.history = [];
    this.pressStartTime = 0;
    this.hasMoved = false;

    // Rotational dynamics
    this.angle = 0;
    this.omega = 0;

    // Physical constants
    this.restitution = 0.85;
    this.friction = 0.985;
    this.angularFriction = 0.96;

    this.squashTimer = null;

    this.boundOnPointerDown = this.onPointerDown.bind(this);
    this.boundOnPointerMove = this.onPointerMove.bind(this);
    this.boundOnPointerUp = this.onPointerUp.bind(this);
    this.boundOnPointerCancel = this.onPointerCancel.bind(this);

    this.createDom();
    this.initEvents();
  }

  createDom() {
    this.el = document.createElement('div');
    this.el.className = 'kc-swimming-mascot';
    this.el.setAttribute('data-swimmer-id', this.id);
    this.el.setAttribute('title', '김크루를 잡아서 던져보세요!');
    this.el.style.backgroundImage = 'url("assets/img/kc-stay.png")';
    this.el.style.transform = `translate3d(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px, 0)`;
    document.body.appendChild(this.el);
  }

  initEvents() {
    this.el.addEventListener('pointerdown', this.boundOnPointerDown);
    this.el.addEventListener('pointermove', this.boundOnPointerMove);
    this.el.addEventListener('pointerup', this.boundOnPointerUp);
    this.el.addEventListener('pointercancel', this.boundOnPointerCancel);
  }

  destroy() {
    if (this.squashTimer) clearTimeout(this.squashTimer);
    this.el.removeEventListener('pointerdown', this.boundOnPointerDown);
    this.el.removeEventListener('pointermove', this.boundOnPointerMove);
    this.el.removeEventListener('pointerup', this.boundOnPointerUp);
    this.el.removeEventListener('pointercancel', this.boundOnPointerCancel);
    if (this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
  }

  getBounds() {
    return {
      left: this.x,
      top: this.y,
      width: this.width,
      height: this.height
    };
  }

  triggerBounceSquash() {
    this.el.classList.add('is-squash');
    if (this.squashTimer) clearTimeout(this.squashTimer);
    this.squashTimer = setTimeout(() => {
      this.el.classList.remove('is-squash');
    }, 140);
  }

  onPointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;

    e.preventDefault();
    e.stopPropagation();

    this.state = 'dragging';
    this.el.classList.add('is-dragging');
    this.el.classList.remove('is-flying', 'is-squash');

    this.grabOffsetX = e.clientX - this.x;
    this.grabOffsetY = e.clientY - this.y;

    const centerX = this.x + this.width / 2;
    const centerY = this.y + this.height / 2;
    this.leverX = e.clientX - centerX;
    this.leverY = e.clientY - centerY;

    this.pointerId = e.pointerId;
    this.history = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    this.pressStartTime = performance.now();
    this.hasMoved = false;
    this.dragVx = 0;
    this.dragVy = 0;

    try {
      this.el.setPointerCapture(e.pointerId);
    } catch (_) {}

    this.el.style.transform = `translate3d(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px, 0) scaleX(${this.facing}) scale(1.08)`;
  }

  onPointerMove(e) {
    if (this.state !== 'dragging' || e.pointerId !== this.pointerId) return;

    const newX = e.clientX - this.grabOffsetX;
    const newY = e.clientY - this.grabOffsetY;
    const dx = newX - this.x;
    const dy = newY - this.y;

    this.dragVx = dx;
    this.dragVy = dy;

    if (Math.hypot(dx, dy) > 2) {
      this.hasMoved = true;
    }

    this.x = newX;
    this.y = newY;

    const now = performance.now();
    this.history.push({ x: e.clientX, y: e.clientY, t: now });
    while (this.history.length > 2 && now - this.history[0].t > 120) {
      this.history.shift();
    }

    // Dynamic tilt based on drag torque
    const dragTorque = (this.leverX * dy - this.leverY * dx) * 0.05;
    this.angle = Math.max(-30, Math.min(30, dragTorque));

    // Facing direction follows drag motion
    if (dx > 0.5) this.facing = 1;
    else if (dx < -0.5) this.facing = -1;

    this.el.style.transform = `translate3d(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px, 0) scaleX(${this.facing}) rotate(${this.angle.toFixed(1)}deg) scale(1.08)`;
  }

  onPointerUp(e) {
    if (this.state !== 'dragging' || e.pointerId !== this.pointerId) return;

    try {
      this.el.releasePointerCapture(e.pointerId);
    } catch (_) {}
    this.pointerId = null;

    this.el.classList.remove('is-dragging');
    this.dragVx = 0;
    this.dragVy = 0;

    // Calculate release velocity
    const now = performance.now();
    let vx = 0;
    let vy = 0;

    if (this.history.length >= 2) {
      const first = this.history[0];
      const last = this.history[this.history.length - 1];
      const dt = Math.max(10, last.t - first.t);
      vx = ((last.x - first.x) / dt) * 16.67;
      vy = ((last.y - first.y) / dt) * 16.67;
    }

    const maxSpeed = 34;
    const speed = Math.hypot(vx, vy);
    if (speed > maxSpeed) {
      vx = (vx / speed) * maxSpeed;
      vy = (vy / speed) * maxSpeed;
    }

    let omega = (this.leverX * vy - this.leverY * vx) * 0.003;
    omega = Math.max(-22, Math.min(22, omega));

    this.vx = vx;
    this.vy = vy;
    this.omega = omega;

    if (speed < 2.0) {
      // Gentle release: resume swimming naturally
      this.state = 'swimming';
      this.heading = Math.atan2(this.vy || 0.1, this.vx || 0.1);
      this.angle = 0;
    } else {
      // Fast fling: free flight & bounce
      this.state = 'flying';
      this.el.classList.add('is-flying');
    }
  }

  onPointerCancel(e) {
    if (this.state === 'dragging' && e.pointerId === this.pointerId) {
      this.onPointerUp(e);
    }
  }

  updateSwimming() {
    this.swimTime += 1;

    // 1. Fluid wandering algorithm
    this.wanderAngle += (Math.random() - 0.5) * 0.12;
    this.wanderAngle = Math.max(-1.1, Math.min(1.1, this.wanderAngle));

    const cruiseSpeed = 1.15;
    this.heading += this.wanderAngle * 0.024;

    let targetVx = Math.cos(this.heading) * cruiseSpeed;
    let targetVy = Math.sin(this.heading) * cruiseSpeed;

    // 2. Soft screen boundary steering (gracefully turn before hitting edges)
    const pad = 40;
    const turnStrength = 0.06;
    const maxX = window.innerWidth - this.width - pad;
    const maxY = window.innerHeight - this.height - pad;

    if (this.x < pad) {
      targetVx += turnStrength * (pad - this.x);
      this.heading = Math.atan2(targetVy, targetVx);
    } else if (this.x > maxX) {
      targetVx -= turnStrength * (this.x - maxX);
      this.heading = Math.atan2(targetVy, targetVx);
    }

    if (this.y < pad) {
      targetVy += turnStrength * (pad - this.y);
      this.heading = Math.atan2(targetVy, targetVx);
    } else if (this.y > maxY) {
      targetVy -= turnStrength * (this.y - maxY);
      this.heading = Math.atan2(targetVy, targetVx);
    }

    // Blend velocity smoothly
    this.vx += (targetVx - this.vx) * 0.05;
    this.vy += (targetVy - this.vy) * 0.05;

    this.x += this.vx;
    this.y += this.vy;

    // Hard bounds clamping
    this.x = Math.max(6, Math.min(window.innerWidth - this.width - 6, this.x));
    this.y = Math.max(6, Math.min(window.innerHeight - this.height - 6, this.y));

    // Facing direction: smoothly flip when swimming left/right
    if (this.vx > 0.08) this.facing = 1;
    else if (this.vx < -0.08) this.facing = -1;

    this.facingScale += (this.facing - this.facingScale) * 0.15;

    // Doggy paddle bob & banking tilt
    const paddleBob = Math.sin(this.swimTime * 0.07) * 3.2;
    const bankAngle = Math.max(-12, Math.min(12, (this.vy * 4) + Math.sin(this.swimTime * 0.05) * 4));

    this.el.style.transform = `translate3d(${this.x.toFixed(1)}px, ${(this.y + paddleBob).toFixed(1)}px, 0) scaleX(${this.facingScale.toFixed(2)}) rotate(${bankAngle.toFixed(1)}deg)`;
  }

  updateFlying() {
    this.x += this.vx;
    this.y += this.vy;
    this.angle += this.omega;

    const pad = 6;
    const maxX = window.innerWidth - this.width - pad;
    const maxY = window.innerHeight - this.height - pad;
    let bounced = false;

    // Wall bounces
    if (this.x <= pad) {
      this.x = pad;
      this.vx = -this.vx * this.restitution;
      this.omega = -this.omega * 0.65 + this.vy * 0.06;
      bounced = true;
    } else if (this.x >= maxX) {
      this.x = maxX;
      this.vx = -this.vx * this.restitution;
      this.omega = -this.omega * 0.65 - this.vy * 0.06;
      bounced = true;
    }

    if (this.y <= pad) {
      this.y = pad;
      this.vy = -this.vy * this.restitution;
      this.omega = -this.omega * 0.65 - this.vx * 0.06;
      bounced = true;
    } else if (this.y >= maxY) {
      this.y = maxY;
      this.vy = -this.vy * this.restitution;
      this.omega = -this.omega * 0.65 + this.vx * 0.06;
      bounced = true;
    }

    if (bounced) {
      this.triggerBounceSquash();
    }

    this.vx *= this.friction;
    this.vy *= this.friction;
    this.omega *= this.angularFriction;

    // Facing direction
    if (this.vx > 0.1) this.facing = 1;
    else if (this.vx < -0.1) this.facing = -1;
    this.facingScale += (this.facing - this.facingScale) * 0.2;

    this.el.style.transform = `translate3d(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px, 0) scaleX(${this.facingScale.toFixed(2)}) rotate(${this.angle.toFixed(1)}deg)`;

    // Seamless transition back to swimming once speed slows down
    const speed = Math.hypot(this.vx, this.vy);
    if (speed < 1.35) {
      this.state = 'swimming';
      this.el.classList.remove('is-flying');
      this.heading = Math.atan2(this.vy, this.vx);
      this.angle = 0;
      this.omega = 0;
    }
  }
}

/**
 * Resolve mutual 2D elastic collision between the 2 swimming Kim Crews
 */
function resolveSwimmerCollisions() {
  if (swimmers.length < 2) return;

  const a = swimmers[0];
  const b = swimmers[1];

  const aCenterX = a.x + a.width / 2;
  const aCenterY = a.y + a.height / 2;
  const bCenterX = b.x + b.width / 2;
  const bCenterY = b.y + b.height / 2;

  const dx = bCenterX - aCenterX;
  const dy = bCenterY - aCenterY;
  const distSq = dx * dx + dy * dy;

  const minDist = 48; // collision diameter

  if (distSq < minDist * minDist && distSq > 0.001) {
    const dist = Math.sqrt(distSq);
    const nx = dx / dist;
    const ny = dy / dist;

    // 1. Positional overlap separation
    const overlap = minDist - dist;
    if (a.state === 'dragging' && b.state !== 'dragging') {
      b.x += nx * overlap;
      b.y += ny * overlap;
    } else if (b.state === 'dragging' && a.state !== 'dragging') {
      a.x -= nx * overlap;
      a.y -= ny * overlap;
    } else {
      a.x -= nx * overlap * 0.5;
      a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5;
      b.y += ny * overlap * 0.5;
    }

    // 2. Relative velocities
    const vaX = a.state === 'dragging' ? a.dragVx : a.vx;
    const vaY = a.state === 'dragging' ? a.dragVy : a.vy;
    const vbX = b.state === 'dragging' ? b.dragVx : b.vx;
    const vbY = b.state === 'dragging' ? b.dragVy : b.vy;

    const relVx = vbX - vaX;
    const relVy = vbY - vaY;
    const velAlongNormal = relVx * nx + relVy * ny;

    if (velAlongNormal < 0) {
      const restitution = 0.88;
      const impulse = -(1 + restitution) * velAlongNormal / 2;

      const impulseX = impulse * nx;
      const impulseY = impulse * ny;

      const tangentX = -ny;
      const tangentY = nx;
      const relTangential = relVx * tangentX + relVy * tangentY;
      const spinImpulse = Math.max(-12, Math.min(12, relTangential * 0.14));

      if (a.state !== 'dragging') {
        a.vx -= impulseX;
        a.vy -= impulseY;
        a.omega -= spinImpulse;
        a.heading = Math.atan2(a.vy, a.vx);
        a.triggerBounceSquash();
      }

      if (b.state !== 'dragging') {
        b.vx += impulseX;
        b.vy += impulseY;
        b.omega += spinImpulse;
        b.heading = Math.atan2(b.vy, b.vx);
        b.triggerBounceSquash();
      }
    }
  }
}

/**
 * 60fps unified swimming & physics loop
 */
function loop() {
  for (const s of swimmers) {
    if (s.state === 'swimming') {
      s.updateSwimming();
    } else if (s.state === 'flying') {
      s.updateFlying();
    }
  }

  resolveSwimmerCollisions();

  swimmingRafId = requestAnimationFrame(loop);
}

/**
 * Mount the 2 swimming Kim Crews when Kim Crew theme is selected
 */
export function mountKimCrewMascots() {
  const currentTheme = getCurrentThemeConfig();
  if (currentTheme.id !== 'kimcrew') {
    dismountKimCrewMascots();
    return;
  }

  // Already mounted?
  if (swimmers.length > 0) return;

  const w = window.innerWidth;
  const h = window.innerHeight;

  // Swimmer 1: starts in upper left quadrant, swimming towards southeast
  const s1 = new SwimmingKimCrew('kc-swimmer-1', Math.max(40, w * 0.15), Math.max(80, h * 0.22), 0.6);

  // Swimmer 2: starts in lower right quadrant, swimming towards northwest
  const s2 = new SwimmingKimCrew('kc-swimmer-2', Math.max(80, w * 0.78), Math.max(120, h * 0.58), 3.6);

  swimmers = [s1, s2];

  if (!swimmingRafId) {
    swimmingRafId = requestAnimationFrame(loop);
  }
}

/**
 * Dismount swimming mascots when switching away from Kim Crew theme
 */
export function dismountKimCrewMascots() {
  if (swimmingRafId) {
    cancelAnimationFrame(swimmingRafId);
    swimmingRafId = null;
  }

  swimmers.forEach(s => s.destroy());
  swimmers = [];
}

/**
 * Initialize theme listener
 */
export function initKimCrewInteractive() {
  onThemeChange((theme) => {
    if (theme.id === 'kimcrew') {
      setTimeout(() => mountKimCrewMascots(), 50);
    } else {
      dismountKimCrewMascots();
    }
  });

  const current = getCurrentThemeConfig();
  if (current.id === 'kimcrew') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => mountKimCrewMascots());
    } else {
      mountKimCrewMascots();
    }
  }
}
