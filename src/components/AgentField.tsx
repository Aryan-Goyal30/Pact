"use client";

// The interactive background system for PACT's "living negotiation
// environment" — a restrained agent-network field, not decoration bolted
// onto a dashboard. Plain <canvas> + requestAnimationFrame, no dependency.
//
// Purely presentational: every prop here is state NegotiationDemo.tsx (or
// the landing page) already owns for real reasons (thinking/status, scroll
// position) — this component never originates negotiation state, and
// nothing it draws is read back by any other part of the app.

import { useEffect, useRef } from "react";

export type AgentFieldPhase = "idle" | "observing" | "evaluating" | "deciding" | "acting" | "agreed";

interface AgentFieldProps {
  phase: AgentFieldPhase;
  /** Which side is currently acting — only meaningful while phase is "evaluating" | "deciding" | "acting". */
  actingSide?: "buyer" | "merchant" | null;
  /** Landing page only: a 0..1 scroll progress value driving a subtle parallax offset. Omitted (or unused) elsewhere. */
  scrollProgress?: number;
  className?: string;
}

interface FieldNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  kind: "buyer" | "merchant" | "ambient";
}

const BUYER_RGB = "96, 165, 250"; // tailwind blue-400
const MERCHANT_RGB = "250, 204, 21"; // tailwind yellow-400
const AMBIENT_RGB = "242, 239, 233"; // --foreground, used sparingly at low alpha

const AMBIENT_NODE_COUNT = 18;
const CONNECTION_DISTANCE = 0.22; // in normalized (0..1) space, relative to min(width,height)

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function buildNodes(): FieldNode[] {
  const nodes: FieldNode[] = [
    { x: 0.1, y: 0.5, vx: 0, vy: 0, r: 5, kind: "buyer" },
    { x: 0.9, y: 0.5, vx: 0, vy: 0, r: 5, kind: "merchant" },
  ];
  for (let i = 0; i < AMBIENT_NODE_COUNT; i++) {
    nodes.push({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00012,
      vy: (Math.random() - 0.5) * 0.00012,
      r: 1 + Math.random() * 1.4,
      kind: "ambient",
    });
  }
  return nodes;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function AgentField({ phase, actingSide = null, scrollProgress = 0, className }: AgentFieldProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<FieldNode[]>([]);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const phaseRef = useRef(phase);
  const actingSideRef = useRef(actingSide);
  const scrollRef = useRef(scrollProgress);
  const actingSinceRef = useRef<number>(0);
  const visibleRef = useRef(true);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (phaseRef.current !== phase) {
      actingSinceRef.current = performance.now();
    }
    phaseRef.current = phase;
    actingSideRef.current = actingSide;
  }, [phase, actingSide]);

  useEffect(() => {
    scrollRef.current = scrollProgress;
  }, [scrollProgress]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    nodesRef.current = buildNodes();

    let width = 0;
    let height = 0;
    let dpr = 1;

    function resize() {
      if (!container || !canvas) return;
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = container.clientWidth;
      height = container.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        visibleRef.current = entry.isIntersecting;
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(container);

    function onPointerMove(e: PointerEvent) {
      const rect = container!.getBoundingClientRect();
      pointerRef.current = { x: (e.clientX - rect.left) / width, y: (e.clientY - rect.top) / height };
    }
    function onPointerLeave() {
      pointerRef.current = null;
    }
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", onPointerLeave);

    const reduced = prefersReducedMotion();

    function drawFrame(now: number) {
      if (!ctx || width === 0 || height === 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const currentPhase = phaseRef.current;
      const acting = actingSideRef.current;
      const parallax = scrollRef.current * 18;
      const nodes = nodesRef.current;
      const pointer = pointerRef.current;

      const activity =
        currentPhase === "idle"
          ? 0.18
          : currentPhase === "observing"
            ? 0.32
            : currentPhase === "evaluating"
              ? 0.55
              : currentPhase === "deciding"
                ? 0.75
                : currentPhase === "acting"
                  ? 0.9
                  : 0.45; // agreed — resolved, calm but not dead

      // Ambient drift (skipped entirely under reduced motion — a single
      // static layout frame is drawn once and then left alone).
      if (!reduced) {
        for (const node of nodes) {
          if (node.kind !== "ambient") continue;
          node.x += node.vx;
          node.y += node.vy;
          if (node.x < 0 || node.x > 1) node.vx *= -1;
          if (node.y < 0 || node.y > 1) node.vy *= -1;
          node.x = Math.min(1, Math.max(0, node.x));
          node.y = Math.min(1, Math.max(0, node.y));

          // While an agent is active, ambient nodes near its anchor drift
          // very slightly toward it — "activity concentrates around the
          // agent" per the design brief, kept subtle.
          if (acting && (currentPhase === "evaluating" || currentPhase === "deciding")) {
            const anchor = nodes.find((n) => n.kind === acting)!;
            const dx = anchor.x - node.x;
            const dy = anchor.y - node.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 0.3 && dist > 0.02) {
              node.x += (dx / dist) * 0.00006;
              node.y += (dy / dist) * 0.00006;
            }
          }
        }
      }

      const px = (x: number) => x * width;
      const py = (y: number) => y * height + parallax;

      // Faint ambient connections — opacity falls off with distance.
      // Perf: rather than one stroke() call per pair (which measurably
      // competed with the compositor for CSS-animation frame budget —
      // confirmed via a direct A/B timing test against a page with no
      // AgentField present), every pair is bucketed into a handful of
      // alpha tiers and each tier is drawn as ONE batched path/stroke
      // call, capping draw calls regardless of node count.
      ctx.lineWidth = 1;
      const CONNECTION_ALPHA_TIERS = 4;
      const tierPaths: Path2D[] = Array.from({ length: CONNECTION_ALPHA_TIERS }, () => new Path2D());
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist > CONNECTION_DISTANCE) continue;
          const strength = 1 - dist / CONNECTION_DISTANCE;
          const baseAlpha = strength * 0.06 * (0.6 + activity);
          if (baseAlpha < 0.003) continue;
          const tier = Math.min(CONNECTION_ALPHA_TIERS - 1, Math.floor(strength * CONNECTION_ALPHA_TIERS));
          tierPaths[tier].moveTo(px(a.x), py(a.y));
          tierPaths[tier].lineTo(px(b.x), py(b.y));
        }
      }
      for (let tier = 0; tier < CONNECTION_ALPHA_TIERS; tier++) {
        const tierAlpha = ((tier + 1) / CONNECTION_ALPHA_TIERS) * 0.06 * (0.6 + activity);
        ctx.strokeStyle = `rgba(${AMBIENT_RGB}, ${tierAlpha})`;
        ctx.stroke(tierPaths[tier]);
      }

      // The buyer<->merchant channel — always present, brighter with
      // activity, calm-steady (not pulsing) once agreed.
      const buyerAnchor = nodes[0];
      const merchantAnchor = nodes[1];
      const channelAlpha = currentPhase === "agreed" ? 0.28 : 0.08 + activity * 0.22;
      ctx.strokeStyle = `rgba(201, 143, 79, ${channelAlpha})`; // --accent
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px(buyerAnchor.x), py(buyerAnchor.y));
      ctx.lineTo(px(merchantAnchor.x), py(merchantAnchor.y));
      ctx.stroke();

      // A signal traveling toward the other agent while genuinely acting.
      if (currentPhase === "acting" && acting && !reduced) {
        const elapsed = now - actingSinceRef.current;
        const t = easeInOutCubic(Math.min(1, elapsed / 900));
        const from = acting === "buyer" ? buyerAnchor : merchantAnchor;
        const to = acting === "buyer" ? merchantAnchor : buyerAnchor;
        const sx = from.x + (to.x - from.x) * t;
        const sy = from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 0.05;
        const color = acting === "buyer" ? BUYER_RGB : MERCHANT_RGB;
        ctx.fillStyle = `rgba(${color}, ${0.85 * (1 - Math.abs(t - 0.5) * 0.3)})`;
        ctx.beginPath();
        ctx.arc(px(sx), py(sy), 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Ambient nodes all share the same alpha at any given frame (a
      // single scalar `activity` drives all of them) — batched into one
      // path/fill call instead of one per node.
      const ambientAlpha = Math.min(1, 0.22 + activity * 0.18);
      const ambientPath = new Path2D();
      for (const node of nodes) {
        if (node.kind !== "ambient") continue;
        ambientPath.moveTo(px(node.x) + node.r, py(node.y));
        ambientPath.arc(px(node.x), py(node.y), node.r, 0, Math.PI * 2);
      }
      ctx.fillStyle = `rgba(${AMBIENT_RGB}, ${ambientAlpha})`;
      ctx.fill(ambientPath);

      // The two anchors get their own draw calls — only two, and each
      // needs its own acting-state size boost.
      for (const node of [buyerAnchor, merchantAnchor]) {
        const color = node.kind === "buyer" ? BUYER_RGB : MERCHANT_RGB;
        const isActingAnchor = node.kind === acting && currentPhase !== "idle" && currentPhase !== "agreed";
        const baseAlpha = Math.min(1, 0.55 + activity * 0.35);
        ctx.fillStyle = `rgba(${color}, ${baseAlpha})`;
        ctx.beginPath();
        ctx.arc(px(node.x), py(node.y), isActingAnchor ? node.r * 1.6 : node.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // A soft cursor-follow light — restrained, low opacity, never a
      // literal particle chase.
      if (pointer) {
        const gradient = ctx.createRadialGradient(
          px(pointer.x),
          py(pointer.y),
          0,
          px(pointer.x),
          py(pointer.y),
          Math.min(width, height) * 0.28,
        );
        gradient.addColorStop(0, "rgba(201, 143, 79, 0.05)");
        gradient.addColorStop(1, "rgba(201, 143, 79, 0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      }
    }

    // Throttled to ~30fps — plenty smooth for slow-drifting ambient
    // particles and halves the main-thread/compositor cost of a purely
    // decorative background.
    let lastDrawAt = 0;
    function loop(now: number) {
      if (visibleRef.current && now - lastDrawAt >= 33) {
        lastDrawAt = now;
        drawFrame(now);
      }
      rafRef.current = requestAnimationFrame(loop);
    }

    if (reduced) {
      drawFrame(performance.now());
    } else {
      rafRef.current = requestAnimationFrame(loop);
    }

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  return (
    <div ref={containerRef} aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ""}`}>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
