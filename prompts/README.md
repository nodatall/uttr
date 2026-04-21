# Cleaning Prompts

This folder contains the built-in cleaning prompt presets available in Uttr's post-processing settings.

## Presets

### Strict (`strict.md`)

**Recommended for: small models (8B and up)**

Rule-based. Follows explicit instructions to fix mechanical errors: spelling, punctuation, number conversion, filler word removal. Preserves exact word order and meaning. Does not paraphrase or interpret.

Use this when speed matters more than nuance, or when running a smaller/faster model.

### Nuanced (`nuanced.md`)

**Recommended for: large models (70B recommended)**

Judgment-based. Gives the model a philosophical brief rather than a rule list. Understands the difference between the human speaker's fingerprint (rhythm, natural phrasing) and the transcription model's artifacts (mishearings, machine-like errors). Can substitute a better word when the transcription clearly got it wrong, while still preserving the speaker's voice.

Use this with a 70B model (e.g. `llama-3.3-70b-versatile` on Groq) for the best results.

## Groq Caching

Groq caches identical system prompts across requests. Using a stable preset (rather than frequently editing a custom prompt) means the system prompt is only processed once — subsequent calls with the same prompt are faster and consume fewer tokens against your rate limit.

## Adding Presets

This folder is for reference. Copy a prompt into the Custom field in settings to use it, or use it as a starting point for your own variation.

To contribute a new preset to the app itself, add a constant to `src-tauri/src/settings.rs` alongside `STRICT_CLEANING_PROMPT` and `NUANCED_CLEANING_PROMPT`, add a variant to `CleaningPromptPreset`, and update the UI in `src/components/settings/post-processing/PostProcessingSettings.tsx`.
