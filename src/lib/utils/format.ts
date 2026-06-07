const MODEL_SIZE_GB_FORMATTERS = {
  whole: new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }),
  decimal: new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }),
};

const MODEL_SIZE_MB_FORMATTERS = {
  whole: new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }),
  decimal: new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }),
};

export const formatModelSize = (sizeMb: number | null | undefined): string => {
  if (!sizeMb || !Number.isFinite(sizeMb) || sizeMb <= 0) {
    return "Unknown size";
  }

  if (sizeMb >= 1024) {
    const sizeGb = sizeMb / 1024;
    const formatter =
      sizeGb >= 10
        ? MODEL_SIZE_GB_FORMATTERS.whole
        : MODEL_SIZE_GB_FORMATTERS.decimal;
    return `${formatter.format(sizeGb)} GB`;
  }

  const formatter =
    sizeMb >= 100
      ? MODEL_SIZE_MB_FORMATTERS.whole
      : MODEL_SIZE_MB_FORMATTERS.decimal;

  return `${formatter.format(sizeMb)} MB`;
};
