import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../../../hooks/useSettings";
import { commands, type PostProcessProvider } from "@/bindings";
import type { ModelOption } from "./types";
import type { DropdownOption } from "../../ui/Dropdown";

type PostProcessProviderState = {
  providerOptions: DropdownOption[];
  selectedProviderId: string;
  selectedProvider: PostProcessProvider | undefined;
  isCustomProvider: boolean;
  isAppleProvider: boolean;
  isGroqProvider: boolean;
  appleIntelligenceUnavailable: boolean;
  baseUrl: string;
  handleBaseUrlChange: (value: string) => void;
  isBaseUrlUpdating: boolean;
  apiKey: string;
  handleApiKeyChange: (value: string) => void;
  isApiKeyUpdating: boolean;
  model: string;
  handleModelChange: (value: string) => void;
  modelOptions: ModelOption[];
  isModelUpdating: boolean;
  isFetchingModels: boolean;
  handleProviderSelect: (providerId: string) => void;
  handleModelSelect: (value: string) => void;
  handleModelCreate: (value: string) => void;
  handleRefreshModels: () => void;
};

const APPLE_PROVIDER_ID = "apple_intelligence";
const GROQ_PROVIDER_ID = "groq";

export const usePostProcessProviderState = (): PostProcessProviderState => {
  const {
    settings,
    isUpdating,
    setPostProcessProvider,
    updatePostProcessBaseUrl,
    updatePostProcessApiKey,
    updatePostProcessModel,
    fetchPostProcessModels,
    postProcessModelOptions,
  } = useSettings();

  // Settings are guaranteed to have providers after migration
  const providers = settings?.post_process_providers || [];
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
  }, [groqProvider, setPostProcessProvider, settings?.post_process_provider_id]);

  const selectedProvider = useMemo(() => {
    return (
      providers.find((provider) => provider.id === selectedProviderId) ||
      providers[0]
    );
  }, [providers, selectedProviderId]);

  const isAppleProvider = selectedProvider?.id === APPLE_PROVIDER_ID;
  const isGroqProvider = selectedProvider?.id === GROQ_PROVIDER_ID;
  const [appleIntelligenceUnavailable, setAppleIntelligenceUnavailable] =
    useState(false);
  const autoFetchedSignatures = useRef<Set<string>>(new Set());

  // Use settings directly as single source of truth
  const baseUrl = selectedProvider?.base_url ?? "";
  const apiKey = settings?.post_process_api_keys?.[selectedProviderId] ?? "";
  const model = settings?.post_process_models?.[selectedProviderId] ?? "";

  const providerOptions = useMemo<DropdownOption[]>(() => {
    const onlyProvider = groqProvider || selectedProvider;
    if (!onlyProvider) return [];
    return [
      {
        value: onlyProvider.id,
        label: onlyProvider.label,
      },
    ];
  }, [groqProvider, selectedProvider]);

  const handleProviderSelect = useCallback(
    async (providerId: string) => {
      // Clear error state on any selection attempt (allows dismissing the error)
      setAppleIntelligenceUnavailable(false);

      if (providerId === selectedProviderId) return;

      // Check Apple Intelligence availability before selecting
      if (providerId === APPLE_PROVIDER_ID) {
        const available = await commands.checkAppleIntelligenceAvailable();
        if (!available) {
          setAppleIntelligenceUnavailable(true);
          // Don't return - still set the provider so dropdown shows the selection
          // The backend gracefully handles unavailable Apple Intelligence
        }
      }

      void setPostProcessProvider(providerId);
    },
    [selectedProviderId, setPostProcessProvider],
  );

  const handleBaseUrlChange = useCallback(
    (value: string) => {
      if (!selectedProvider || selectedProvider.id !== "custom") {
        return;
      }
      const trimmed = value.trim();
      if (trimmed && trimmed !== baseUrl) {
        void updatePostProcessBaseUrl(selectedProvider.id, trimmed);
      }
    },
    [selectedProvider, baseUrl, updatePostProcessBaseUrl],
  );

  const handleApiKeyChange = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed !== apiKey) {
        void updatePostProcessApiKey(selectedProviderId, trimmed);
      }
    },
    [apiKey, selectedProviderId, updatePostProcessApiKey],
  );

  const handleModelChange = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed !== model) {
        void updatePostProcessModel(selectedProviderId, trimmed);
      }
    },
    [model, selectedProviderId, updatePostProcessModel],
  );

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

  const availableModelsRaw = postProcessModelOptions[selectedProviderId] || [];

  const modelOptions = useMemo<ModelOption[]>(() => {
    const seen = new Set<string>();
    const options: ModelOption[] = [];

    // Exclude models not suited for text cleanup: speech-to-text, safety classifiers,
    // TTS, agentic compound models, and non-English focused models.
    const EXCLUDED_PATTERNS = ["whisper", "guard", "safeguard", "orpheus", "compound", "kimi"];
    const isExcluded = (id: string) =>
      EXCLUDED_PATTERNS.some((p) => id.toLowerCase().includes(p));

    // Strip provider prefix for display (e.g. "meta-llama/llama-4-scout" → "llama-4-scout")
    const displayLabel = (id: string) => id.includes("/") ? id.split("/").pop()! : id;

    // Extract model size in billions for sorting (e.g. "70b" → 70, "22m" → 0.022, missing → Infinity)
    const modelSizeB = (id: string): number => {
      const match = id.toLowerCase().match(/(\d+(?:\.\d+)?)(b|m)/);
      if (!match) return Infinity;
      const num = parseFloat(match[1]);
      return match[2] === "m" ? num / 1000 : num;
    };

    const filtered = availableModelsRaw.filter((id) => !isExcluded(id));
    filtered.sort((a, b) => modelSizeB(a) - modelSizeB(b));

    for (const candidate of filtered) {
      const trimmed = candidate.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      options.push({ value: trimmed, label: displayLabel(trimmed) });
    }

    // Ensure current model is in the list
    const currentTrimmed = model?.trim();
    if (currentTrimmed && !seen.has(currentTrimmed)) {
      seen.add(currentTrimmed);
      options.push({ value: currentTrimmed, label: displayLabel(currentTrimmed) });
    }

    return options;
  }, [availableModelsRaw, model]);

  const isBaseUrlUpdating = isUpdating(
    `post_process_base_url:${selectedProviderId}`,
  );
  const isApiKeyUpdating = isUpdating(
    `post_process_api_key:${selectedProviderId}`,
  );
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

    if (autoFetchedSignatures.current.has(autoFetchSignature)) {
      return;
    }

    autoFetchedSignatures.current.add(autoFetchSignature);
    void fetchPostProcessModels(selectedProviderId);
  }, [
    autoFetchSignature,
    fetchPostProcessModels,
    isFetchingModels,
    selectedProviderId,
  ]);

  return {
    providerOptions,
    selectedProviderId,
    selectedProvider,
    isCustomProvider,
    isAppleProvider,
    isGroqProvider,
    appleIntelligenceUnavailable,
    baseUrl,
    handleBaseUrlChange,
    isBaseUrlUpdating,
    apiKey,
    handleApiKeyChange,
    isApiKeyUpdating,
    model,
    handleModelChange,
    modelOptions,
    isModelUpdating,
    isFetchingModels,
    handleProviderSelect,
    handleModelSelect,
    handleModelCreate,
    handleRefreshModels,
  };
};
