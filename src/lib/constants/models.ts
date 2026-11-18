export const SCRIBE_LIVE_MODEL_ID = "elevenlabs-scribe-v3-live";

export const isCloudModel = (modelId: string): boolean =>
  modelId.startsWith("groq-") ||
  modelId.startsWith("openai-") ||
  modelId === SCRIBE_LIVE_MODEL_ID;
