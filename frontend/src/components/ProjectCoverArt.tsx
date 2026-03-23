/**
 * ProjectCoverArt — deterministic abstract SVG art generated from project metadata.
 *
 * Uses a seeded PRNG derived from the project title + description to produce
 * unique, subtle, research-themed abstract visuals (flowing curves, scattered
 * dots, layered gradients). The palette shifts based on project type.
 *
 * No external API — pure math + SVG.
 */

import { useMemo } from 'react';

// ── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Color palettes per project type ─────────────────────────────────────────

type ProjectType = 'write' | 'systematic_review' | 'revision' | string;

interface Palette {
  bg: [string, string];      // gradient stops
  shapes: string[];           // shape fill colors (with opacity)
  glow: string;               // radial glow color
}

const PALETTES: Record<string, Palette> = {
  write: {
    bg: ['#1a1040', '#0d0828'],
    shapes: [
      'rgba(129,140,248,0.35)',
      'rgba(99,102,241,0.25)',
      'rgba(165,180,252,0.15)',
      'rgba(79,70,229,0.20)',
      'rgba(196,181,253,0.12)',
    ],
    glow: 'rgba(129,140,248,0.12)',
  },
  systematic_review: {
    bg: ['#0a2820', '#061a14'],
    shapes: [
      'rgba(52,211,153,0.30)',
      'rgba(16,185,129,0.25)',
      'rgba(110,231,183,0.15)',
      'rgba(5,150,105,0.20)',
      'rgba(167,243,208,0.12)',
    ],
    glow: 'rgba(52,211,153,0.12)',
  },
  revision: {
    bg: ['#2a1838', '#1a0e28'],
    shapes: [
      'rgba(167,139,250,0.35)',
      'rgba(139,92,246,0.25)',
      'rgba(196,181,253,0.15)',
      'rgba(124,58,237,0.20)',
      'rgba(221,214,254,0.12)',
    ],
    glow: 'rgba(167,139,250,0.12)',
  },
};

function getPalette(type: ProjectType): Palette {
  if (type === 'systematic_review') return PALETTES.systematic_review;
  if (type === 'revision') return PALETTES.revision;
  return PALETTES.write;
}

// ── Shape generators ────────────────────────────────────────────────────────

function genFlowingCurve(rng: () => number, w: number, h: number): string {
  const x0 = rng() * w * 0.3;
  const y0 = rng() * h;
  const cp1x = w * 0.25 + rng() * w * 0.3;
  const cp1y = rng() * h;
  const cp2x = w * 0.5 + rng() * w * 0.3;
  const cp2y = rng() * h;
  const x1 = w * 0.7 + rng() * w * 0.3;
  const y1 = rng() * h;
  return `M${x0},${y0} C${cp1x},${cp1y} ${cp2x},${cp2y} ${x1},${y1}`;
}

function genCircle(rng: () => number, w: number, h: number) {
  return {
    cx: rng() * w,
    cy: rng() * h,
    r: 2 + rng() * 40,
  };
}

function genOrbitPath(rng: () => number, w: number, h: number): string {
  const cx = w * 0.3 + rng() * w * 0.4;
  const cy = h * 0.3 + rng() * h * 0.4;
  const rx = 30 + rng() * 80;
  const ry = 20 + rng() * 60;
  const rot = rng() * 360;
  return `M${cx - rx},${cy} A${rx},${ry} ${rot} 1,1 ${cx + rx},${cy} A${rx},${ry} ${rot} 1,1 ${cx - rx},${cy}`;
}

// ── Main component ──────────────────────────────────────────────────────────

interface Props {
  title: string;
  description?: string;
  projectType?: ProjectType;
  className?: string;
  width?: number;
  height?: number;
}

export default function ProjectCoverArt({
  title,
  description = '',
  projectType = 'write',
  className = '',
  width = 600,
  height = 240,
}: Props) {
  const svgContent = useMemo(() => {
    const seed = hashString(title + '|' + description);
    const rng = mulberry32(seed);
    const pal = getPalette(projectType);

    // Flowing curves (3–5)
    const curveCount = 3 + Math.floor(rng() * 3);
    const curves: { d: string; color: string; width: number; opacity: number }[] = [];
    for (let i = 0; i < curveCount; i++) {
      curves.push({
        d: genFlowingCurve(rng, width, height),
        color: pal.shapes[i % pal.shapes.length],
        width: 1 + rng() * 3,
        opacity: 0.3 + rng() * 0.5,
      });
    }

    // Scattered dots (8–18)
    const dotCount = 8 + Math.floor(rng() * 11);
    const dots: { cx: number; cy: number; r: number; color: string; opacity: number }[] = [];
    for (let i = 0; i < dotCount; i++) {
      const c = genCircle(rng, width, height);
      dots.push({
        ...c,
        r: 1 + rng() * 4,
        color: pal.shapes[i % pal.shapes.length],
        opacity: 0.2 + rng() * 0.6,
      });
    }

    // Soft blobs (2–4 large circles with heavy blur)
    const blobCount = 2 + Math.floor(rng() * 3);
    const blobs: { cx: number; cy: number; r: number; color: string }[] = [];
    for (let i = 0; i < blobCount; i++) {
      const c = genCircle(rng, width, height);
      blobs.push({
        cx: c.cx,
        cy: c.cy,
        r: 30 + rng() * 60,
        color: pal.shapes[i % pal.shapes.length],
      });
    }

    // Orbit ellipses (1–2)
    const orbitCount = 1 + Math.floor(rng() * 2);
    const orbits: { d: string; color: string; opacity: number }[] = [];
    for (let i = 0; i < orbitCount; i++) {
      orbits.push({
        d: genOrbitPath(rng, width, height),
        color: pal.shapes[(i + 2) % pal.shapes.length],
        opacity: 0.15 + rng() * 0.2,
      });
    }

    // Constellation lines connecting some dots (3–6 lines)
    const lineCount = Math.min(3 + Math.floor(rng() * 4), dots.length - 1);
    const lines: { x1: number; y1: number; x2: number; y2: number; opacity: number }[] = [];
    for (let i = 0; i < lineCount; i++) {
      const a = dots[i];
      const b = dots[(i + 1 + Math.floor(rng() * 3)) % dots.length];
      lines.push({
        x1: a.cx, y1: a.cy,
        x2: b.cx, y2: b.cy,
        opacity: 0.08 + rng() * 0.12,
      });
    }

    // Glow position
    const glowX = 30 + rng() * 40;
    const glowY = 20 + rng() * 60;

    return { pal, curves, dots, blobs, orbits, lines, glowX, glowY };
  }, [title, description, projectType, width, height]);

  const { pal, curves, dots, blobs, orbits, lines, glowX, glowY } = svgContent;
  const filterId = `blur-${hashString(title)}`;
  const gradId = `bg-${hashString(title)}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={pal.bg[0]} />
          <stop offset="100%" stopColor={pal.bg[1]} />
        </linearGradient>
        <filter id={filterId}>
          <feGaussianBlur stdDeviation="20" />
        </filter>
      </defs>

      {/* Background gradient */}
      <rect width={width} height={height} fill={`url(#${gradId})`} />

      {/* Atmospheric glow */}
      <circle
        cx={`${glowX}%`}
        cy={`${glowY}%`}
        r="120"
        fill={pal.glow}
        filter={`url(#${filterId})`}
      />

      {/* Soft blobs (blurred background elements) */}
      {blobs.map((b, i) => (
        <circle
          key={`blob-${i}`}
          cx={b.cx}
          cy={b.cy}
          r={b.r}
          fill={b.color}
          filter={`url(#${filterId})`}
        />
      ))}

      {/* Orbit ellipses */}
      {orbits.map((o, i) => (
        <path
          key={`orbit-${i}`}
          d={o.d}
          fill="none"
          stroke={o.color}
          strokeWidth="0.5"
          opacity={o.opacity}
        />
      ))}

      {/* Constellation lines */}
      {lines.map((l, i) => (
        <line
          key={`line-${i}`}
          x1={l.x1}
          y1={l.y1}
          x2={l.x2}
          y2={l.y2}
          stroke="rgba(255,255,255,0.15)"
          strokeWidth="0.5"
          opacity={l.opacity}
        />
      ))}

      {/* Flowing curves */}
      {curves.map((c, i) => (
        <path
          key={`curve-${i}`}
          d={c.d}
          fill="none"
          stroke={c.color}
          strokeWidth={c.width}
          opacity={c.opacity}
          strokeLinecap="round"
        />
      ))}

      {/* Scattered dots */}
      {dots.map((d, i) => (
        <circle
          key={`dot-${i}`}
          cx={d.cx}
          cy={d.cy}
          r={d.r}
          fill={d.color}
          opacity={d.opacity}
        />
      ))}

      {/* Subtle noise texture overlay */}
      <rect
        width={width}
        height={height}
        fill="url(#noise)"
        opacity="0.03"
      />
    </svg>
  );
}
