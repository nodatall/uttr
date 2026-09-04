import { LANGUAGES } from "@/lib/constants/languages";

const DATE_TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

const SUPPORTED_FORMAT_LOCALES = LANGUAGES.reduce<string[]>(
  (locales, language) => {
    if (language.value !== "auto") {
      locales.push(language.value);
    }
    return locales;
  },
  [],
);

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

for (const locale of SUPPORTED_FORMAT_LOCALES) {
  try {
    dateTimeFormatters.set(
      locale,
      new Intl.DateTimeFormat(locale, DATE_TIME_FORMAT_OPTIONS),
    );
  } catch {
    // Skip runtimes that do not support a configured app locale.
  }
}

/**
 * Format a date string or timestamp to a localized date and time string
 * @param timestamp - Unix timestamp in seconds (as string)
 * @param locale - BCP 47 language tag (e.g., 'en', 'es', 'fr')
 * @returns Formatted date string
 */
export const formatDateTime = (timestamp: string, locale: string): string => {
  try {
    // Convert Unix timestamp (seconds) to milliseconds
    const timestampMs = parseInt(timestamp, 10) * 1000;
    const date = new Date(timestampMs);

    // Check if date is valid
    if (isNaN(date.getTime())) {
      return timestamp; // Return original if invalid
    }

    return (
      dateTimeFormatters.get(locale)?.format(date) ??
      date.toLocaleString(locale, DATE_TIME_FORMAT_OPTIONS)
    );
  } catch (error) {
    console.error("Failed to format date:", error);
    return timestamp; // Fallback to original timestamp
  }
};
