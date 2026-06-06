import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import type { ModelOption } from "./types";

type ModelSelectProps = {
  value: string;
  options: ModelOption[];
  disabled?: boolean;
  placeholder?: string;
  isLoading?: boolean;
  onSelect: (value: string) => void;
  onCreate: (value: string) => void;
  onBlur: () => void;
  className?: string;
};

export const ModelSelect: React.FC<ModelSelectProps> = React.memo(
  ({
    value,
    options,
    disabled,
    placeholder,
    isLoading,
    onSelect,
    onCreate,
    onBlur,
    className = "min-w-0 flex-1",
  }) => {
    const { t } = useTranslation();
    const [isOpen, setIsOpen] = useState(false);
    const [inputValue, setInputValue] = useState("");
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const selectedOption = useMemo(
      () => options.find((option) => option.value === value),
      [options, value],
    );
    const displayValue = selectedOption?.label ?? value;
    const visibleInputValue = isOpen ? inputValue : displayValue;

    useEffect(() => {
      const handlePointerDown = (event: MouseEvent) => {
        if (
          containerRef.current &&
          !containerRef.current.contains(event.target as Node)
        ) {
          setIsOpen(false);
        }
      };

      document.addEventListener("mousedown", handlePointerDown);
      return () => document.removeEventListener("mousedown", handlePointerDown);
    }, []);

    const filteredOptions = useMemo(() => {
      const query = visibleInputValue.trim().toLowerCase();
      if (!query || query === displayValue.toLowerCase()) {
        return options;
      }

      return options.filter((option) => {
        const valueText = option.value.toLowerCase();
        const labelText = option.label.toLowerCase();
        return valueText.includes(query) || labelText.includes(query);
      });
    }, [displayValue, options, visibleInputValue]);

    const boundedHighlightedIndex = Math.min(
      highlightedIndex,
      Math.max(filteredOptions.length - 1, 0),
    );

    const handleCreate = (inputValue: string) => {
      const trimmed = inputValue.trim();
      if (!trimmed) return;
      onCreate(trimmed);
      setInputValue(trimmed);
      setIsOpen(false);
    };

    const handleSelect = (option: ModelOption) => {
      onSelect(option.value);
      setInputValue(option.label);
      setIsOpen(false);
    };

    const handleClear = () => {
      onSelect("");
      setInputValue("");
      setIsOpen(false);
      inputRef.current?.focus();
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (disabled) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIsOpen(true);
        setHighlightedIndex((current) =>
          Math.min(current + 1, Math.max(filteredOptions.length - 1, 0)),
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setInputValue(displayValue);
        setIsOpen(false);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const highlighted = filteredOptions[boundedHighlightedIndex];
        if (isOpen && highlighted) {
          handleSelect(highlighted);
          return;
        }
        handleCreate(inputValue);
      }
    };

    const exactInputMatch = options.some(
      (option) =>
        option.value.toLowerCase() === inputValue.trim().toLowerCase() ||
        option.label.toLowerCase() === inputValue.trim().toLowerCase(),
    );
    const exactCurrentValueMatch =
      value.trim().toLowerCase() === inputValue.trim().toLowerCase() ||
      displayValue.toLowerCase() === inputValue.trim().toLowerCase();
    const createOptionLabel = `${t("common.create")}: ${inputValue.trim()}`;

    return (
      <div ref={containerRef} className={`relative text-sm ${className}`}>
        <div
          className={`flex h-10 w-full min-w-0 items-center rounded-md border bg-mid-gray/10 transition-colors duration-150 ${
            isOpen
              ? "border-logo-primary bg-logo-primary/20 shadow-[0_0_0_1px_var(--color-logo-primary)]"
              : "border-mid-gray/80 hover:border-logo-primary hover:bg-logo-primary/12"
          } ${disabled ? "opacity-50" : ""}`}
        >
          <input
            ref={inputRef}
            type="text"
            value={visibleInputValue}
            placeholder={placeholder}
            aria-label={placeholder}
            disabled={disabled}
            onBlur={onBlur}
            onChange={(event) => {
              setInputValue(event.target.value);
              setHighlightedIndex(0);
              setIsOpen(true);
            }}
            onFocus={() => {
              setInputValue(displayValue);
              setIsOpen(true);
            }}
            onKeyDown={handleKeyDown}
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm text-text outline-none placeholder:text-mid-gray/65"
          />
          {value && !disabled && (
            <button
              type="button"
              aria-label="Clear model"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleClear}
              className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-mid-gray transition-colors hover:bg-white/8 hover:text-logo-primary"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            aria-label="Show model options"
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              inputRef.current?.focus();
              setIsOpen((open) => !open);
            }}
            className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-mid-gray transition-colors hover:bg-white/8 hover:text-logo-primary disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ChevronDown
                className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
              />
            )}
          </button>
        </div>

        {isOpen && !disabled && (
          <div className="absolute top-full right-0 left-0 z-50 mt-2 max-h-64 overflow-y-auto rounded-lg border border-white/10 bg-[rgba(8,14,24,0.98)] py-1 shadow-[0_18px_40px_rgba(2,6,23,0.45)] backdrop-blur-xl">
            {filteredOptions.map((option, index) => (
              <button
                key={option.value}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSelect(option)}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={`flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                  index === boundedHighlightedIndex
                    ? "bg-logo-primary/14 text-text"
                    : "text-text/90 hover:bg-white/[0.05]"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.value === value && (
                  <Check className="h-4 w-4 shrink-0 text-logo-primary" />
                )}
              </button>
            ))}

            {inputValue.trim() &&
              !exactInputMatch &&
              !exactCurrentValueMatch && (
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleCreate(inputValue)}
                  className="flex w-full min-w-0 items-center gap-2 border-t border-white/8 px-3 py-2 text-left text-sm text-text/90 transition-colors hover:bg-white/[0.05]"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {createOptionLabel}
                  </span>
                </button>
              )}

            {filteredOptions.length === 0 && !inputValue.trim() && (
              <div className="px-3 py-2 text-sm text-mid-gray">
                {placeholder}
              </div>
            )}
          </div>
        )}
      </div>
    );
  },
);

ModelSelect.displayName = "ModelSelect";
