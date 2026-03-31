export function buildTimings(
  startMs: number,
  groqStartMs: number,
  groqEndMs: number,
  endMs: number,
) {
  return {
    total_ms: Math.round(endMs - startMs),
    preflight_ms: Math.round(groqStartMs - startMs),
    groq_ms: Math.round(groqEndMs - groqStartMs),
    persistence_ms: Math.round(endMs - groqEndMs),
    backend_overhead_ms: Math.round(endMs - startMs - (groqEndMs - groqStartMs)),
  };
}
