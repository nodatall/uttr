import { useEffect, useMemo, useRef } from "react";

const ROSE_THREE_CONFIG = {
  rotate: true,
  particleCount: 76,
  trailSpan: 0.31,
  durationMs: 5300,
  rotationDurationMs: 28000,
  pulseDurationMs: 4400,
  strokeWidth: 4.6,
  roseA: 9.2,
  roseABoost: 0.6,
  roseBreathBase: 0.72,
  roseBreathBoost: 0.28,
  roseScale: 3.25,
};

interface RoseThreeLoaderProps {
  className?: string;
  ariaLabel?: string;
}

const normalizeProgress = (progress: number) => ((progress % 1) + 1) % 1;

const getDetailScale = (time: number) => {
  const pulseProgress =
    (time % ROSE_THREE_CONFIG.pulseDurationMs) /
    ROSE_THREE_CONFIG.pulseDurationMs;
  const pulseAngle = pulseProgress * Math.PI * 2;

  return 0.52 + ((Math.sin(pulseAngle + 0.55) + 1) / 2) * 0.48;
};

const getRotation = (time: number) => {
  if (!ROSE_THREE_CONFIG.rotate) {
    return 0;
  }

  return (
    -(
      (time % ROSE_THREE_CONFIG.rotationDurationMs) /
      ROSE_THREE_CONFIG.rotationDurationMs
    ) * 360
  );
};

const getPoint = (progress: number, detailScale: number) => {
  const t = progress * Math.PI * 2;
  const a =
    ROSE_THREE_CONFIG.roseA + detailScale * ROSE_THREE_CONFIG.roseABoost;
  const r =
    a *
    (ROSE_THREE_CONFIG.roseBreathBase +
      detailScale * ROSE_THREE_CONFIG.roseBreathBoost) *
    Math.cos(3 * t);

  return {
    x: 50 + Math.cos(t) * r * ROSE_THREE_CONFIG.roseScale,
    y: 50 + Math.sin(t) * r * ROSE_THREE_CONFIG.roseScale,
  };
};

const buildPath = (detailScale: number, steps = 480) => {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const point = getPoint(index / steps, detailScale);
    return `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }).join(" ");
};

const getParticle = (index: number, progress: number, detailScale: number) => {
  const tailOffset = index / (ROSE_THREE_CONFIG.particleCount - 1);
  const point = getPoint(
    normalizeProgress(progress - tailOffset * ROSE_THREE_CONFIG.trailSpan),
    detailScale,
  );
  const fade = Math.pow(1 - tailOffset, 0.56);

  return {
    x: point.x,
    y: point.y,
    radius: 0.9 + fade * 2.7,
    opacity: 0.04 + fade * 0.96,
  };
};

export default function RoseThreeLoader({
  className = "h-24 w-24 text-logo-primary",
  ariaLabel = "Loading",
}: RoseThreeLoaderProps) {
  const groupRef = useRef<SVGGElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const particleRefs = useRef<Array<SVGCircleElement | null>>([]);
  const particles = useMemo(
    () =>
      Array.from(
        { length: ROSE_THREE_CONFIG.particleCount },
        (_, index) => index,
      ),
    [],
  );

  useEffect(() => {
    let frameId = 0;
    const startedAt = performance.now();
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const render = (now: number) => {
      const time = reduceMotion ? 0 : now - startedAt;
      const progress =
        (time % ROSE_THREE_CONFIG.durationMs) / ROSE_THREE_CONFIG.durationMs;
      const detailScale = getDetailScale(time);

      groupRef.current?.setAttribute(
        "transform",
        `rotate(${getRotation(time)} 50 50)`,
      );
      pathRef.current?.setAttribute("d", buildPath(detailScale));

      particleRefs.current.forEach((node, index) => {
        if (!node) {
          return;
        }

        const particle = getParticle(index, progress, detailScale);
        node.setAttribute("cx", particle.x.toFixed(2));
        node.setAttribute("cy", particle.y.toFixed(2));
        node.setAttribute("r", particle.radius.toFixed(2));
        node.setAttribute("opacity", particle.opacity.toFixed(3));
      });

      if (!reduceMotion) {
        frameId = requestAnimationFrame(render);
      }
    };

    frameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, []);

  return (
    <svg
      viewBox="0 0 100 100"
      fill="none"
      role="img"
      aria-label={ariaLabel}
      className={className}
    >
      <g ref={groupRef}>
        <path
          ref={pathRef}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={ROSE_THREE_CONFIG.strokeWidth}
          opacity="0.1"
        />
        {particles.map((index) => (
          <circle
            key={index}
            ref={(node) => {
              particleRefs.current[index] = node;
            }}
            fill="currentColor"
          />
        ))}
      </g>
    </svg>
  );
}
