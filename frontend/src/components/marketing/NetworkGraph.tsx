'use client';

import { useEffect, useRef } from 'react';
import { EDGE_COLOR, NODE_COLOR, PULSE_COLOR } from './live-graph/physics';

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  opacity: number;
}

interface Pulse {
  fromIdx: number;
  toIdx: number;
  progress: number;
  speed: number;
}

const EDGE_THRESHOLD = 180;

export function NetworkGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    let w = 0;
    let h = 0;
    const dpr = window.devicePixelRatio || 1;

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const nodeCount = w < 640 ? 14 : 28;
    const nodes: Node[] = Array.from({ length: nodeCount }, () => ({
      x: Math.random() * (w || 800),
      y: Math.random() * (h || 600),
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      radius: 2 + Math.random() * 3,
      opacity: 0.3 + Math.random() * 0.5,
    }));

    const pulses: Pulse[] = [];
    let pulseTimer = 0;

    function spawnPulse() {
      if (nodes.length < 2) return;
      for (let attempt = 0; attempt < 10; attempt++) {
        const a = Math.floor(Math.random() * nodes.length);
        const b = Math.floor(Math.random() * nodes.length);
        if (a === b) continue;
        const dx = nodes[a].x - nodes[b].x;
        const dy = nodes[a].y - nodes[b].y;
        if (Math.sqrt(dx * dx + dy * dy) < EDGE_THRESHOLD) {
          pulses.push({
            fromIdx: a,
            toIdx: b,
            progress: 0,
            speed: 0.008 + Math.random() * 0.006,
          });
          return;
        }
      }
    }

    function draw() {
      ctx!.clearRect(0, 0, w, h);

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < EDGE_THRESHOLD) {
            const alpha = (1 - dist / EDGE_THRESHOLD) * 0.25;
            ctx!.strokeStyle = `rgba(${EDGE_COLOR[0]},${EDGE_COLOR[1]},${EDGE_COLOR[2]},${alpha})`;
            ctx!.lineWidth = 1;
            ctx!.beginPath();
            ctx!.moveTo(nodes[i].x, nodes[i].y);
            ctx!.lineTo(nodes[j].x, nodes[j].y);
            ctx!.stroke();
          }
        }
      }

      for (const pulse of pulses) {
        const from = nodes[pulse.fromIdx];
        const to = nodes[pulse.toIdx];
        const px = from.x + (to.x - from.x) * pulse.progress;
        const py = from.y + (to.y - from.y) * pulse.progress;
        const glow = ctx!.createRadialGradient(px, py, 0, px, py, 8);
        glow.addColorStop(
          0,
          `rgba(${PULSE_COLOR[0]},${PULSE_COLOR[1]},${PULSE_COLOR[2]},0.8)`,
        );
        glow.addColorStop(
          1,
          `rgba(${PULSE_COLOR[0]},${PULSE_COLOR[1]},${PULSE_COLOR[2]},0)`,
        );
        ctx!.fillStyle = glow;
        ctx!.beginPath();
        ctx!.arc(px, py, 8, 0, Math.PI * 2);
        ctx!.fill();
      }

      for (const node of nodes) {
        ctx!.fillStyle = `rgba(${NODE_COLOR[0]},${NODE_COLOR[1]},${NODE_COLOR[2]},${node.opacity})`;
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx!.fill();
      }
    }

    function tick() {
      for (const node of nodes) {
        node.x += node.vx;
        node.y += node.vy;

        if (node.x < 0 || node.x > w) node.vx *= -1;
        if (node.y < 0 || node.y > h) node.vy *= -1;
        node.x = Math.max(0, Math.min(w, node.x));
        node.y = Math.max(0, Math.min(h, node.y));
      }

      for (let i = pulses.length - 1; i >= 0; i--) {
        pulses[i].progress += pulses[i].speed;
        if (pulses[i].progress >= 1) pulses.splice(i, 1);
      }

      pulseTimer++;
      if (pulseTimer > 120) {
        pulseTimer = 0;
        spawnPulse();
      }
    }

    if (prefersReducedMotion) {
      draw();
      return () => ro.disconnect();
    }

    function loop() {
      tick();
      draw();
      animRef.current = requestAnimationFrame(loop);
    }
    animRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animRef.current);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      aria-label="Animated network graph showing connected agent nodes"
    >
      Agent network visualization
    </canvas>
  );
}
