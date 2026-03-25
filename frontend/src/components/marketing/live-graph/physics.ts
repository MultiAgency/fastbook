export const NODE_COLOR = [78, 125, 247];
export const EDGE_COLOR = [47, 81, 192];
export const PULSE_COLOR = [146, 170, 249];

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Pulse {
  edge: GraphEdge;
  progress: number;
  speed: number;
}

const SPRING_STRENGTH = 0.0004;
const SPRING_LENGTH = 120;
const REPULSION = 800;
const CENTER_GRAVITY = 0.00015;
const DAMPING = 0.92;

export function applyForces(
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeMap: Map<string, GraphNode>,
  w: number,
  h: number,
): void {
  const pad = 40;
  const cx = w / 2;
  const cy = h / 2;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    a.vx += (cx - a.x) * CENTER_GRAVITY;
    a.vy += (cy - a.y) * CENTER_GRAVITY;

    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) dist = 1;
      const force = REPULSION / (dist * dist);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  for (const edge of edges) {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    if (!from || !to) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) dist = 1;
    const displacement = dist - SPRING_LENGTH;
    const force = displacement * SPRING_STRENGTH;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    from.vx += fx;
    from.vy += fy;
    to.vx -= fx;
    to.vy -= fy;
  }

  for (const node of nodes) {
    node.vx *= DAMPING;
    node.vy *= DAMPING;
    node.x += node.vx;
    node.y += node.vy;

    if (node.x < pad) {
      node.x = pad;
      node.vx *= -0.5;
    }
    if (node.x > w - pad) {
      node.x = w - pad;
      node.vx *= -0.5;
    }
    if (node.y < pad) {
      node.y = pad;
      node.vy *= -0.5;
    }
    if (node.y > h - pad) {
      node.y = h - pad;
      node.vy *= -0.5;
    }
  }
}

export function updatePulses(
  pulses: Pulse[],
  edges: GraphEdge[],
  pulseTimer: { value: number },
): void {
  for (let i = pulses.length - 1; i >= 0; i--) {
    pulses[i].progress += pulses[i].speed;
    if (pulses[i].progress >= 1) pulses.splice(i, 1);
  }

  pulseTimer.value++;
  if (pulseTimer.value > 90 && edges.length > 0) {
    pulseTimer.value = 0;
    const edge = edges[Math.floor(Math.random() * edges.length)];
    pulses.push({
      edge,
      progress: 0,
      speed: 0.006 + Math.random() * 0.004,
    });
  }
}
