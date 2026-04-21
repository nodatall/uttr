"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

type Star = {
  x: number;
  y: number;
  size: number;
  drift: number;
  twinkleOffset: number;
  twinkleSpeed: number;
  baseAlpha: number;
  warm: boolean;
};

type ShootingStar = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
};

type SwirlStar = {
  radius: number;
  phase: number;
  arm: number;
  speed: number;
  size: number;
  alpha: number;
  warm: boolean;
  scatter: number;
  depth: number;
  twinkleSpeed: number;
};

function pseudoRandom(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453123;
  return x - Math.floor(x);
}

export function GalaxyCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);

  const reducedMotion = useSyncExternalStore(
    (callback) => {
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const sources = [
      "/galaxy-hero-user.png",
      "/galaxy-hero-user.jpg",
      "/galaxy-hero-user.jpeg",
      "/galaxy-hero-user.webp",
    ];
    const source = new Image();
    let sourceIndex = 0;

    const loadNextSource = () => {
      if (sourceIndex >= sources.length) {
        return;
      }
      source.src = sources[sourceIndex];
      sourceIndex += 1;
    };

    source.onerror = () => {
      loadNextSource();
    };
    loadNextSource();

    const stars: Star[] = [];
    const shootingStars: ShootingStar[] = [];
    const swirlStars: SwirlStar[] = [];

    for (let i = 0; i < 210; i += 1) {
      stars.push({
        x: pseudoRandom(i + 1),
        y: pseudoRandom(i + 31),
        size: 0.4 + pseudoRandom(i + 101) * 1.8,
        drift: 0.000007 + pseudoRandom(i + 241) * 0.000024,
        twinkleOffset: pseudoRandom(i + 401) * Math.PI * 2,
        twinkleSpeed: 0.8 + pseudoRandom(i + 641) * 1.5,
        baseAlpha: 0.2 + pseudoRandom(i + 881) * 0.65,
        warm: pseudoRandom(i + 1041) > 0.72,
      });
    }

    for (let i = 0; i < 460; i += 1) {
      swirlStars.push({
        radius: 0.08 + pseudoRandom(i + 1301) * 0.98,
        phase: pseudoRandom(i + 1601) * Math.PI * 2,
        arm: Math.floor(pseudoRandom(i + 1901) * 5),
        speed: 0.00008 + pseudoRandom(i + 2201) * 0.00016,
        size: 0.28 + pseudoRandom(i + 2501) * 1.02,
        alpha: 0.12 + pseudoRandom(i + 2801) * 0.4,
        warm: pseudoRandom(i + 3101) > 0.66,
        scatter: 5 + pseudoRandom(i + 3401) * 18,
        depth: pseudoRandom(i + 3701),
        twinkleSpeed: 0.95 + pseudoRandom(i + 4001) * 1.45,
      });
    }

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const parent = canvas.parentElement;
      if (!parent) return;

      const width = parent.clientWidth;
      const height = parent.clientHeight;

      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (time: number) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) {
        frameRef.current = requestAnimationFrame(draw);
        return;
      }

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#050812";
      ctx.fillRect(0, 0, w, h);

      if (source.complete && source.naturalWidth > 0) {
        const baseScale = Math.max(
          w / source.naturalWidth,
          h / source.naturalHeight,
        );
        const pulse = reducedMotion ? 1 : 1 + Math.sin(time * 0.00028) * 0.018;
        const rotation = reducedMotion ? 0 : Math.sin(time * 0.00009) * 0.006;

        const drawW = source.naturalWidth * baseScale * 1.08 * pulse;
        const drawH = source.naturalHeight * baseScale * 1.08 * pulse;

        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(rotation);
        ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
      }

      ctx.fillStyle = "rgba(5, 7, 15, 0.14)";
      ctx.fillRect(0, 0, w, h);

      const t = time * 0.001;

      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      for (let i = 0; i < stars.length; i += 1) {
        const star = stars[i];
        const x = ((star.x + t * star.drift) % 1) * w;
        const y = star.y * h;
        const twinkle = reducedMotion
          ? 1
          : 0.68 + Math.sin(t * star.twinkleSpeed + star.twinkleOffset) * 0.32;
        const alpha = Math.max(0.08, star.baseAlpha * twinkle);

        ctx.fillStyle = star.warm
          ? `rgba(255, 224, 172, ${alpha})`
          : `rgba(200, 227, 255, ${alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, star.size, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!reducedMotion) {
        const cx = w * 0.52;
        const cy = h * 0.39;
        const spiralScaleX = w * 0.42;
        const spiralScaleY = h * 0.3;
        const arms = 5;

        for (let i = 0; i < swirlStars.length; i += 1) {
          const star = swirlStars[i];
          const spin = t * star.speed * 100;
          const armOffset = (star.arm / arms) * Math.PI * 2;
          const angle = star.phase + spin + armOffset;
          const spiralAngle = angle + star.radius * 3.5;
          const radius = star.radius * (0.58 + 0.42 * star.depth);
          const turbulence =
            (Math.sin(t * 0.82 + star.phase * 2.1) +
              Math.cos(t * 0.51 + star.phase * 1.3)) *
            0.5;
          const jitter = star.scatter * (0.54 + 0.46 * turbulence);

          const sx =
            cx +
            Math.cos(spiralAngle) * spiralScaleX * radius +
            Math.cos(angle * 2.15 + t * 0.17) * jitter;
          const sy =
            cy +
            Math.sin(spiralAngle) * spiralScaleY * radius +
            Math.sin(angle * 1.72 - t * 0.13) * jitter * 0.72;

          const twinkle =
            0.72 + Math.sin(t * star.twinkleSpeed + star.phase) * 0.28;
          const alpha = Math.max(0.06, star.alpha * twinkle);
          const size = star.size * (0.95 + star.depth * 0.3);

          ctx.fillStyle = star.warm
            ? `rgba(255, 220, 168, ${alpha})`
            : `rgba(188, 222, 255, ${alpha})`;
          ctx.beginPath();
          ctx.arc(sx, sy, size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (!reducedMotion && Math.random() < 0.012 && shootingStars.length < 2) {
        shootingStars.push({
          x: Math.random() * (w * 0.7) + w * 0.15,
          y: Math.random() * (h * 0.35) + h * 0.08,
          vx: -(0.35 + Math.random() * 0.35),
          vy: 0.12 + Math.random() * 0.2,
          life: 0,
          maxLife: 65 + Math.random() * 40,
        });
      }

      for (let i = shootingStars.length - 1; i >= 0; i -= 1) {
        const star = shootingStars[i];
        star.life += 1;
        star.x += star.vx * 7.2;
        star.y += star.vy * 7.2;

        const lifePct = star.life / star.maxLife;
        if (lifePct >= 1) {
          shootingStars.splice(i, 1);
          continue;
        }

        const alpha = (1 - lifePct) * 0.85;
        const tailLen = 60 + lifePct * 36;
        const tailX = star.x - star.vx * tailLen;
        const tailY = star.y - star.vy * tailLen;

        const grad = ctx.createLinearGradient(star.x, star.y, tailX, tailY);
        grad.addColorStop(0, `rgba(255, 236, 193, ${alpha})`);
        grad.addColorStop(1, "rgba(255, 236, 193, 0)");

        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(star.x, star.y);
        ctx.lineTo(tailX, tailY);
        ctx.stroke();
      }

      ctx.restore();

      frameRef.current = requestAnimationFrame(draw);
    };

    resize();
    frameRef.current = requestAnimationFrame(draw);

    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, [reducedMotion]);

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      <canvas ref={canvasRef} className="h-full w-full" />
      <div className="pointer-events-none absolute inset-0 star-grid opacity-12" />
    </div>
  );
}
