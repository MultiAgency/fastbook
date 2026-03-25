'use client';

import { useEffect, useRef } from 'react';
import type { GraphEdge, GraphNode, Pulse } from './physics';
import {
  applyForces,
  EDGE_COLOR,
  NODE_COLOR,
  PULSE_COLOR,
  updatePulses,
} from './physics';
import { useGraphData } from './use-graph-data';

const LABEL_COLOR = [160, 160, 170];

function buildAdjacency(edges: GraphEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, new Set());
    if (!adjacency.has(e.to)) adjacency.set(e.to, new Set());
    adjacency.get(e.from)!.add(e.to);
    adjacency.get(e.to)!.add(e.from);
  }
  return adjacency;
}

function hitTestNode(
  nodes: GraphNode[],
  mx: number,
  my: number,
): string | null {
  for (const node of nodes) {
    const dx = mx - node.x;
    const dy = my - node.y;
    if (dx * dx + dy * dy < (node.radius + 8) * (node.radius + 8)) {
      return node.id;
    }
  }
  return null;
}

interface HoverState {
  id: string | null;
  neighbors: Set<string> | null;
}

function rgba(color: number[], alpha: number): string {
  return `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
}

function drawEdges(
  ctx: CanvasRenderingContext2D,
  edges: GraphEdge[],
  nodeMap: Map<string, GraphNode>,
  hover: HoverState,
): void {
  const hasHover = hover.id !== null;

  for (const edge of edges) {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    if (!from || !to) continue;
    const highlighted =
      hasHover && (edge.from === hover.id || edge.to === hover.id);
    const alpha = hasHover ? (highlighted ? 0.5 : 0.05) : 0.2;
    ctx.strokeStyle = rgba(EDGE_COLOR, alpha);
    ctx.lineWidth = highlighted ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }
}

function drawPulses(
  ctx: CanvasRenderingContext2D,
  pulses: Pulse[],
  nodeMap: Map<string, GraphNode>,
): void {
  for (const pulse of pulses) {
    const from = nodeMap.get(pulse.edge.from);
    const to = nodeMap.get(pulse.edge.to);
    if (!from || !to) continue;
    const px = from.x + (to.x - from.x) * pulse.progress;
    const py = from.y + (to.y - from.y) * pulse.progress;
    const glow = ctx.createRadialGradient(px, py, 0, px, py, 10);
    glow.addColorStop(0, rgba(PULSE_COLOR, 0.9));
    glow.addColorStop(1, rgba(PULSE_COLOR, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(px, py, 10, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawNodes(
  ctx: CanvasRenderingContext2D,
  nodes: GraphNode[],
  hover: HoverState,
): void {
  const hasHover = hover.id !== null;

  for (const node of nodes) {
    const isHovered = hover.id === node.id;
    const isNeighbor = hover.neighbors?.has(node.id) ?? false;
    const dimmed = hasHover && !isHovered && !isNeighbor;

    const glowAlpha = dimmed ? 0.05 : 0.25;
    const glow = ctx.createRadialGradient(
      node.x,
      node.y,
      0,
      node.x,
      node.y,
      node.radius * 3,
    );
    glow.addColorStop(0, rgba(NODE_COLOR, glowAlpha));
    glow.addColorStop(1, rgba(NODE_COLOR, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius * 3, 0, Math.PI * 2);
    ctx.fill();

    const coreAlpha = dimmed ? 0.2 : 0.8;
    ctx.fillStyle = rgba(NODE_COLOR, coreAlpha);
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    ctx.fill();

    const labelAlpha = dimmed ? 0.1 : isHovered ? 0.9 : 0.5;
    ctx.fillStyle = rgba(LABEL_COLOR, labelAlpha);
    ctx.font = isHovered ? 'bold 10px sans-serif' : '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(node.label, node.x, node.y + node.radius + 12);
  }
}

function drawGraph(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  nodes: GraphNode[],
  edges: GraphEdge[],
  nodeMap: Map<string, GraphNode>,
  adjacency: Map<string, Set<string>>,
  pulses: Pulse[],
  hoverId: string | null,
): void {
  ctx.clearRect(0, 0, w, h);
  const hover: HoverState = {
    id: hoverId,
    neighbors: hoverId ? (adjacency.get(hoverId) ?? null) : null,
  };

  drawEdges(ctx, edges, nodeMap, hover);
  drawPulses(ctx, pulses, nodeMap);
  drawNodes(ctx, nodes, hover);
}

export function LiveGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const hoverRef = useRef<string | null>(null);
  const graphData = useGraphData();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graphData || graphData.nodes.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    let w = 0;
    let h = 0;
    const dpr = window.devicePixelRatio || 1;

    const nodes = graphData.nodes.map((n) => ({ ...n }));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const edges = graphData.edges.filter(
      (e) => nodeMap.has(e.from) && nodeMap.has(e.to),
    );
    const adjacency = buildAdjacency(edges);

    const pulses: Pulse[] = [];
    const pulseTimer = { value: 0 };
    let initialized = false;

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (!initialized) {
        for (const node of nodes) {
          node.x *= w;
          node.y *= h;
        }
        initialized = true;
      }
    }

    function handleMouseMove(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      hoverRef.current = hitTestNode(nodes, mx, my);
      canvas!.style.cursor = hoverRef.current ? 'pointer' : 'default';
    }

    function handleMouseLeave() {
      hoverRef.current = null;
      canvas!.style.cursor = 'default';
    }

    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    function tick() {
      applyForces(nodes, edges, nodeMap, w, h);
      updatePulses(pulses, edges, pulseTimer);
    }

    if (prefersReducedMotion) {
      for (let i = 0; i < 200; i++) tick();
      drawGraph(
        ctx,
        w,
        h,
        nodes,
        edges,
        nodeMap,
        adjacency,
        pulses,
        hoverRef.current,
      );
      return () => {
        canvas.removeEventListener('mousemove', handleMouseMove);
        canvas.removeEventListener('mouseleave', handleMouseLeave);
        ro.disconnect();
      };
    }

    function loop() {
      tick();
      drawGraph(
        ctx!,
        w,
        h,
        nodes,
        edges,
        nodeMap,
        adjacency,
        pulses,
        hoverRef.current,
      );
      animRef.current = requestAnimationFrame(loop);
    }
    animRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animRef.current);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      ro.disconnect();
    };
  }, [graphData]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      tabIndex={-1}
      aria-label="Live force-directed graph of registered agents and their follow connections"
    >
      Live agent network graph
    </canvas>
  );
}
