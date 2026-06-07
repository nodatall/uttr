import { LANGUAGES } from "@/lib/constants/languages";

const DATE_TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

const DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
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
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();

for (const locale of SUPPORTED_FORMAT_LOCALES) {
  try {
    dateTimeFormatters.set(
      locale,
      new Intl.DateTimeFormat(locale, DATE_TIME_FORMAT_OPTIONS),
    );
    dateFormatters.set(
      locale,
      new Intl.DateTimeFormat(locale, DATE_FORMAT_OPTIONS),
    );
    relativeTimeFormatters.set(
      locale,
      new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
    );
  } catch {
    // Skip runtimes that do not support a configured app locale.
  }
}

const FALLBACK_RELATIVE_TIME_FORMATTER =
  relativeTimeFormatters.get("en") ??
  new Intl.RelativeTimeFormat("en", { numeric: "auto" });

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

/**
 * Format a date string or timestamp to a localized date string (no time)
 * @param timestamp - Unix timestamp in seconds (as string)
 * @param locale - BCP 47 language tag (e.g., 'en', 'es', 'fr')
 * @returns Formatted date string
 */
const formatDate = (timestamp: string, locale: string): string => {
  try {
    // Convert Unix timestamp (seconds) to milliseconds
    const timestampMs = parseInt(timestamp, 10) * 1000;
    const date = new Date(timestampMs);

    // Check if date is valid
    if (isNaN(date.getTime())) {
      return timestamp; // Return original if invalid
    }

    return (
      dateFormatters.get(locale)?.format(date) ??
      date.toLocaleDateString(locale, DATE_FORMAT_OPTIONS)
    );
  } catch (error) {
    console.error("Failed to format date:", error);
    return timestamp; // Fallback to original timestamp
  }
};

/**
 * Format a date string or timestamp to a relative time string (e.g., "2 hours ago")
 * @param timestamp - Unix timestamp in seconds (as string)
 * @param locale - BCP 47 language tag (e.g., 'en', 'es', 'fr')
 * @returns Relative time string
 */
const formatRelativeTime = (timestamp: string, locale: string): string => {
  try {
    // Convert Unix timestamp (seconds) to milliseconds
    const timestampMs = parseInt(timestamp, 10) * 1000;
    const date = new Date(timestampMs);
    const now = new Date();

    // Check if date is valid
    if (isNaN(date.getTime())) {
      return timestamp; // Return original if invalid
    }

    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    // Use Intl.RelativeTimeFormat for proper localization
    const rtf =
      relativeTimeFormatters.get(locale) ?? FALLBACK_RELATIVE_TIME_FORMATTER;

    // Less than a minute
    if (diffInSeconds < 60) {
      return rtf.format(-diffInSeconds, "second");
    }

    // Less than an hour
    const diffInMinutes = Math.floor(diffInSeconds / 60);
    if (diffInMinutes < 60) {
      return rtf.format(-diffInMinutes, "minute");
    }

    // Less than a day
    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours < 24) {
      return rtf.format(-diffInHours, "hour");
    }

    // Less than a week
    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays < 7) {
      return rtf.format(-diffInDays, "day");
    }

    // Less than a month (30 days)
    if (diffInDays < 30) {
      const diffInWeeks = Math.floor(diffInDays / 7);
      return rtf.format(-diffInWeeks, "week");
    }

    // Less than a year
    if (diffInDays < 365) {
      const diffInMonths = Math.floor(diffInDays / 30);
      return rtf.format(-diffInMonths, "month");
    }

    // More than a year
    const diffInYears = Math.floor(diffInDays / 365);
    return rtf.format(-diffInYears, "year");
  } catch (error) {
    console.error("Failed to format relative time:", error);
    return formatDateTime(timestamp, locale); // Fallback to absolute time
  }
};
