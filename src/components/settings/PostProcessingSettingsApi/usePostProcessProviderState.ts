import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSettings } from "../../../hooks/useSettings";
import type { PostProcessProvider } from "@/bindings";
import type { ModelOption } from "./types";

type PostProcessProviderState = {
  isCustomProvider: boolean;
  model: string;
  modelOptions: ModelOption[];
  isModelUpdating: boolean;
  isFetchingModels: boolean;
  handleModelSelect: (value: string) => void;
  handleModelCreate: (value: string) => void;
  handleRefreshModels: () => void;
};

const APPLE_PROVIDER_ID = "apple_intelligence";
const GROQ_PROVIDER_ID = "groq";
const EMPTY_PROVIDERS: PostProcessProvider[] = [];
const EMPTY_MODELS: string[] = [];
const EXCLUDED_MODEL_PATTERNS = [
  "whisper",
  "guard",
  "safeguard",
  "orpheus",
  "compound",
  "kimi",
];

const isExcludedModel = (id: string) =>
  EXCLUDED_MODEL_PATTERNS.some((pattern) => id.toLowerCase().includes(pattern));

const displayModelLabel = (id: string) =>
  id.includes("/") ? id.split("/").pop()! : id;

const modelSizeB = (id: string): number => {
  const match = id.toLowerCase().match(/(\d+(?:\.\d+)?)(b|m)/);
  if (!match) return Infinity;
  const num = parseFloat(match[1]);
  return match[2] === "m" ? num / 1000 : num;
};

export const usePostProcessProviderState = (): PostProcessProviderState => {
  const {
    settings,
    isUpdating,
    setPostProcessProvider,
    updatePostProcessModel,
    fetchPostProcessModels,
    postProcessModelOptions,
    postProcessApiKeyStatuses,
  } = useSettings();

  // Settings are guaranteed to have providers after migration
  const providers = settings?.post_process_providers ?? EMPTY_PROVIDERS;
  const groqProvider = useMemo(
    () => providers.find((provider) => provider.id === GROQ_PROVIDER_ID),
    [providers],
  );

  const selectedProviderId = useMemo(() => {
    return (
      groqProvider?.id ||
      settings?.post_process_provider_id ||
      providers[0]?.id ||
      GROQ_PROVIDER_ID
    );
  }, [groqProvider?.id, providers, settings?.post_process_provider_id]);

  useEffect(() => {
    if (
      groqProvider &&
      settings?.post_process_provider_id &&
      settings.post_process_provider_id !== groqProvider.id
    ) {
      void setPostProcessProvider(groqProvider.id);
    }
  }, [
    groqProvider,
    setPostProcessProvider,
    settings?.post_process_provider_id,
  ]);

  const selectedProvider = useMemo(() => {
    return (
      providers.find((provider) => provider.id === selectedProviderId) ||
      providers[0]
    );
  }, [providers, selectedProviderId]);

  const isAppleProvider = selectedProvider?.id === APPLE_PROVIDER_ID;
  const autoFetchedSignatures = useRef<Set<string> | null>(null);
  if (autoFetchedSignatures.current === null) {
    autoFetchedSignatures.current = new Set();
  }

  // Use settings directly as single source of truth
  const baseUrl = selectedProvider?.base_url ?? "";
  const hasStoredApiKey =
    postProcessApiKeyStatuses[selectedProviderId] ?? false;
  const apiKey = hasStoredApiKey ? "stored" : "";
  const model = settings?.post_process_models?.[selectedProviderId] ?? "";

  const handleModelSelect = useCallback(
    (value: string) => {
      void updatePostProcessModel(selectedProviderId, value.trim());
    },
    [selectedProviderId, updatePostProcessModel],
  );

  const handleModelCreate = useCallback(
    (value: string) => {
      void updatePostProcessModel(selectedProviderId, value);
    },
    [selectedProviderId, updatePostProcessModel],
  );

  const handleRefreshModels = useCallback(() => {
    if (isAppleProvider) return;
    void fetchPostProcessModels(selectedProviderId);
  }, [fetchPostProcessModels, isAppleProvider, selectedProviderId]);

  const availableModelsRaw =
    postProcessModelOptions[selectedProviderId] ?? EMPTY_MODELS;

  const modelOptions = useMemo<ModelOption[]>(() => {
    const seen = new Set<string>();
    const options: ModelOption[] = [];

    const filtered = availableModelsRaw.filter((id) => !isExcludedModel(id));
    filtered.sort((a, b) => modelSizeB(a) - modelSizeB(b));

    for (const candidate of filtered) {
      const trimmed = candidate.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      options.push({ value: trimmed, label: displayModelLabel(trimmed) });
    }

    // Ensure current model is in the list
    const currentTrimmed = model?.trim();
    if (currentTrimmed && !seen.has(currentTrimmed)) {
      seen.add(currentTrimmed);
      options.push({
        value: currentTrimmed,
        label: displayModelLabel(currentTrimmed),
      });
    }

    return options;
  }, [availableModelsRaw, model]);

  const isModelUpdating = isUpdating(
    `post_process_model:${selectedProviderId}`,
  );
  const isFetchingModels = isUpdating(
    `post_process_models_fetch:${selectedProviderId}`,
  );

  const isCustomProvider = selectedProvider?.id === "custom";

  const autoFetchSignature = useMemo(() => {
    if (!selectedProvider || isAppleProvider) {
      return null;
    }

    const trimmedBaseUrl = baseUrl.trim();
    const trimmedApiKey = apiKey.trim();

    if (isCustomProvider && !trimmedBaseUrl) {
      return null;
    }

    if (!isCustomProvider && !trimmedApiKey) {
      return null;
    }

    return `${selectedProviderId}:${trimmedBaseUrl}:${trimmedApiKey}`;
  }, [
    apiKey,
    baseUrl,
    isAppleProvider,
    isCustomProvider,
    selectedProvider,
    selectedProviderId,
  ]);

  useEffect(() => {
    if (!autoFetchSignature || isFetchingModels) {
      return;
    }

    const fetchedSignatures = autoFetchedSignatures.current;
    if (!fetchedSignatures || fetchedSignatures.has(autoFetchSignature)) {
      return;
    }

    fetchedSignatures.add(autoFetchSignature);
    void fetchPostProcessModels(selectedProviderId);
  }, [
    autoFetchSignature,
    fetchPostProcessModels,
    isFetchingModels,
    selectedProviderId,
  ]);

  return {
    isCustomProvider,
    model,
    modelOptions,
    isModelUpdating,
    isFetchingModels,
    handleModelSelect,
    handleModelCreate,
    handleRefreshModels,
  };
};
