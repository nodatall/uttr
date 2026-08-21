use natural::phonetics::soundex;
use once_cell::sync::Lazy;
use regex::Regex;
use strsim::levenshtein;

const ASR_PROMPT_LEAK_FRAGMENTS: &[&str] = &[
    "Transcribe short desktop dictation accurately.",
    "The speaker may be quiet, fast, or mumbled.",
    "If speech is present, transcribe the spoken words verbatim with normal punctuation.",
    "Preserve spoken filler words and hesitation sounds such as um, uh, uhm, and uhh.",
];
const MAX_CUSTOM_WORD_NGRAM: usize = 4;
const NGRAM_ADDITIONAL_TOKEN_PENALTY: f64 = 0.03;

/// Builds an n-gram string by cleaning and concatenating words
///
/// Strips punctuation from each word, lowercases, and joins without spaces.
/// This allows matching "Charge B" against "ChargeBee".
fn build_ngram(words: &[&str]) -> String {
    words
        .iter()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .collect::<Vec<_>>()
        .concat()
}

/// Finds the best matching custom word for a candidate string
///
/// Uses Levenshtein distance and Soundex phonetic matching to find
/// the best match above the given threshold.
///
/// # Arguments
/// * `candidate` - The cleaned/lowercased candidate string to match
/// * `custom_words` - Original custom words (for returning the replacement)
/// * `custom_words_nospace` - Custom words with spaces removed, lowercased (for comparison)
/// * `threshold` - Maximum similarity score to accept
///
/// # Returns
/// The best matching custom word and its score, if any match was found
fn find_best_match<'a>(
    candidate: &str,
    custom_words: &'a [String],
    custom_words_nospace: &[String],
    threshold: f64,
) -> Option<(&'a String, f64)> {
    if candidate.is_empty() || candidate.len() > 50 {
        return None;
    }

    let mut best_match: Option<&String> = None;
    let mut best_score = f64::MAX;

    for (i, custom_word_nospace) in custom_words_nospace.iter().enumerate() {
        // Skip if lengths are too different (optimization + prevents over-matching)
        // Use percentage-based check: max 25% length difference (prevents n-grams from
        // matching significantly shorter custom words, e.g., "openaigpt" vs "openai")
        let len_diff = (candidate.len() as i32 - custom_word_nospace.len() as i32).abs() as f64;
        let max_len = candidate.len().max(custom_word_nospace.len()) as f64;
        let max_allowed_diff = (max_len * 0.25).max(2.0); // At least 2 chars difference allowed
        if len_diff > max_allowed_diff {
            continue;
        }

        // Calculate Levenshtein distance (normalized by length)
        let levenshtein_dist = levenshtein(candidate, custom_word_nospace);
        let max_len = candidate.len().max(custom_word_nospace.len()) as f64;
        let levenshtein_score = if max_len > 0.0 {
            levenshtein_dist as f64 / max_len
        } else {
            1.0
        };

        // Calculate phonetic similarity using Soundex
        let phonetic_match = soundex(candidate, custom_word_nospace);

        // Combine scores: favor phonetic matches, but also consider string similarity
        let combined_score = if phonetic_match {
            levenshtein_score * 0.3 // Give significant boost to phonetic matches
        } else {
            levenshtein_score
        };

        // Accept if the score is good enough (configurable threshold)
        if combined_score < threshold && combined_score < best_score {
            best_match = Some(&custom_words[i]);
            best_score = combined_score;
        }
    }

    best_match.map(|m| (m, best_score))
}

/// Applies custom word corrections to transcribed text using fuzzy matching
///
/// This function corrects words in the input text by finding the best matches
/// from a list of custom words using a combination of:
/// - Levenshtein distance for string similarity
/// - Soundex phonetic matching for pronunciation similarity
/// - N-gram matching for multi-word speech artifacts (e.g., "Charge B" -> "ChargeBee")
///
/// # Arguments
/// * `text` - The input text to correct
/// * `custom_words` - List of custom words to match against
/// * `threshold` - Maximum similarity score to accept (0.0 = exact match, 1.0 = any match)
///
/// # Returns
/// The corrected text with custom words applied
pub fn apply_custom_words(text: &str, custom_words: &[String], threshold: f64) -> String {
    if custom_words.is_empty() {
        return text.to_string();
    }

    // Pre-compute lowercase versions to avoid repeated allocations
    let custom_words_lower: Vec<String> = custom_words.iter().map(|w| w.to_lowercase()).collect();

    // Pre-compute versions with spaces removed for n-gram comparison
    let custom_words_nospace: Vec<String> = custom_words_lower
        .iter()
        .map(|w| w.replace(' ', ""))
        .collect();

    let words: Vec<&str> = text.split_whitespace().collect();
    let mut result = Vec::new();
    let mut i = 0;

    while i < words.len() {
        let mut best_match: Option<(usize, &String, f64)> = None;

        // Prefer the closest match, using the longer n-gram only as a tiebreaker.
        // A longest-first match can consume an unrelated preceding word when a
        // shorter exact pronunciation is available (for example, "è Charge B").
        for n in (1..=MAX_CUSTOM_WORD_NGRAM).rev() {
            if i + n > words.len() {
                continue;
            }

            let ngram_words = &words[i..i + n];
            let ngram = build_ngram(ngram_words);

            if let Some((replacement, score)) =
                find_best_match(&ngram, custom_words, &custom_words_nospace, threshold)
            {
                let adjusted_score =
                    score + (n.saturating_sub(1) as f64 * NGRAM_ADDITIONAL_TOKEN_PENALTY);
                let better_match_starts_at_next_word = n > 1
                    && (1..=MAX_CUSTOM_WORD_NGRAM.min(words.len().saturating_sub(i + 1))).any(
                        |next_n| {
                            let next_candidate = build_ngram(&words[i + 1..i + 1 + next_n]);
                            find_best_match(
                                &next_candidate,
                                custom_words,
                                &custom_words_nospace,
                                threshold,
                            )
                            .map(|(next_replacement, next_score)| {
                                let next_adjusted_score = next_score
                                    + (next_n.saturating_sub(1) as f64
                                        * NGRAM_ADDITIONAL_TOKEN_PENALTY);
                                next_replacement == replacement
                                    && next_adjusted_score <= adjusted_score
                            })
                            .unwrap_or(false)
                        },
                    );
                if better_match_starts_at_next_word {
                    continue;
                }

                let should_replace = best_match
                    .as_ref()
                    .map(|(best_n, _, best_score)| {
                        adjusted_score < *best_score
                            || (adjusted_score == *best_score && n > *best_n)
                    })
                    .unwrap_or(true);
                if should_replace {
                    best_match = Some((n, replacement, adjusted_score));
                }
            }
        }

        if let Some((n, replacement, _)) = best_match {
            let ngram_words = &words[i..i + n];
            let (prefix, _) = extract_punctuation(ngram_words[0]);
            let (_, suffix) = extract_punctuation(ngram_words[n - 1]);
            let corrected = preserve_case_pattern(ngram_words[0], replacement);

            result.push(format!("{}{}{}", prefix, corrected, suffix));
            i += n;
        } else {
            result.push(words[i].to_string());
            i += 1;
        }
    }

    result.join(" ")
}

/// Preserves the case pattern of the original word when applying a replacement
fn preserve_case_pattern(original: &str, replacement: &str) -> String {
    if original.chars().all(|c| c.is_uppercase()) {
        replacement.to_uppercase()
    } else if original.chars().next().map_or(false, |c| c.is_uppercase()) {
        let mut chars: Vec<char> = replacement.chars().collect();
        if let Some(first_char) = chars.get_mut(0) {
            *first_char = first_char.to_uppercase().next().unwrap_or(*first_char);
        }
        chars.into_iter().collect()
    } else {
        replacement.to_string()
    }
}

/// Extracts punctuation prefix and suffix from a word
fn extract_punctuation(word: &str) -> (&str, &str) {
    let prefix_end = word.chars().take_while(|c| !c.is_alphanumeric()).count();
    let suffix_start = word
        .char_indices()
        .rev()
        .take_while(|(_, c)| !c.is_alphanumeric())
        .count();

    let prefix = if prefix_end > 0 {
        &word[..prefix_end]
    } else {
        ""
    };

    let suffix = if suffix_start > 0 {
        &word[word.len() - suffix_start..]
    } else {
        ""
    };

    (prefix, suffix)
}

/// Filler words to remove from transcriptions
const FILLER_WORDS: &[&str] = &[
    "uh", "um", "uhm", "umm", "uhh", "uhhh", "ah", "eh", "hmm", "hm", "mmm", "mm", "mh", "ha",
    "ehh",
];

static MULTI_SPACE_PATTERN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s{2,}").unwrap());

/// Collapses repeated 1-2 letter words (3+ repetitions) to a single instance.
/// E.g., "wh wh wh wh" -> "wh", "I I I I" -> "I"
fn collapse_stutters(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return text.to_string();
    }

    let mut result: Vec<&str> = Vec::new();
    let mut i = 0;

    while i < words.len() {
        let word = words[i];
        let word_lower = word.to_lowercase();

        // Only process 1-2 letter words
        if word_lower.len() <= 2 && word_lower.chars().all(|c| c.is_alphabetic()) {
            // Count consecutive repetitions (case-insensitive)
            let mut count = 1;
            while i + count < words.len() && words[i + count].to_lowercase() == word_lower {
                count += 1;
            }

            // If 3+ repetitions, collapse to single instance
            if count >= 3 {
                result.push(word);
                i += count;
            } else {
                result.push(word);
                i += 1;
            }
        } else {
            result.push(word);
            i += 1;
        }
    }

    result.join(" ")
}

/// Pre-compiled filler word patterns (built lazily)
static FILLER_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    FILLER_WORDS
        .iter()
        .map(|word| {
            // Match filler word with word boundaries, optionally followed by comma or period
            Regex::new(&format!(r"(?i)\b{}\b[,.]?", regex::escape(word))).unwrap()
        })
        .collect()
});

static ASR_PROMPT_LEAK_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    ASR_PROMPT_LEAK_FRAGMENTS
        .iter()
        .map(|fragment| Regex::new(&format!(r"(?i){}", regex::escape(fragment))).unwrap())
        .collect()
});

fn strip_asr_prompt_leaks(text: &str) -> String {
    let mut filtered = text.to_string();
    for pattern in ASR_PROMPT_LEAK_PATTERNS.iter() {
        filtered = pattern.replace_all(&filtered, " ").to_string();
    }
    filtered
}

/// Filters transcription output by removing filler words and stutter artifacts.
///
/// This function cleans up raw transcription text by:
/// 1. Removing known ASR prompt leakage
/// 2. Removing filler words (uh, um, hmm, etc.)
/// 3. Collapsing repeated 1-2 letter stutters (e.g., "wh wh wh" -> "wh")
/// 4. Cleaning up excess whitespace
///
/// # Arguments
/// * `text` - The raw transcription text to filter
///
/// # Returns
/// The filtered text with filler words and stutters removed
pub fn filter_transcription_output(text: &str) -> String {
    let mut filtered = strip_asr_prompt_leaks(text);

    // Remove filler words
    for pattern in FILLER_PATTERNS.iter() {
        filtered = pattern.replace_all(&filtered, "").to_string();
    }

    // Collapse repeated 1-2 letter words (stutter artifacts like "wh wh wh wh")
    filtered = collapse_stutters(&filtered);

    // Clean up multiple spaces to single space
    filtered = MULTI_SPACE_PATTERN.replace_all(&filtered, " ").to_string();

    // Trim leading/trailing whitespace
    filtered.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_vocabulary_corrections_cover_supported_matching_behavior() {
        let cases = [
            (
                "exact matches",
                "hello world",
                vec!["Hello", "World"],
                "Hello World",
            ),
            (
                "fuzzy matches",
                "helo wrold",
                vec!["hello", "world"],
                "hello world",
            ),
            (
                "no configured vocabulary",
                "hello world",
                vec![],
                "hello world",
            ),
            (
                "two-word pronunciation",
                "il cui nome è Charge B, che permette",
                vec!["ChargeBee"],
                "il cui nome è ChargeBee, che permette",
            ),
            (
                "three-word pronunciation",
                "use Chat G P T for this",
                vec!["ChatGPT"],
                "use ChatGPT for this",
            ),
            (
                "longest n-gram wins",
                "Open AI GPT model",
                vec!["OpenAI", "GPT"],
                "OpenAI GPT model",
            ),
            (
                "uppercase pronunciation",
                "CHARGE B is great",
                vec!["ChargeBee"],
                "CHARGEBEE is great",
            ),
            (
                "punctuation around a pronunciation",
                "!charge b?",
                vec!["ChargeBee"],
                "!ChargeBee?",
            ),
            (
                "spaces in custom term",
                "using Mac Book Pro",
                vec!["MacBook Pro"],
                "using MacBook Pro",
            ),
            (
                "trailing number is not duplicated",
                "use GPT4 for this",
                vec!["GPT-4"],
                "use GPT-4 for this",
            ),
        ];

        for (name, text, custom_words, expected) in cases {
            let custom_words = custom_words
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>();
            assert_eq!(
                apply_custom_words(text, &custom_words, 0.5),
                expected,
                "case: {name}"
            );
        }
    }

    #[test]
    fn transcription_filter_covers_supported_cleanup_behavior() {
        let cases = [
            (
                "filler words",
                "So um I was thinking uh about this",
                "So I was thinking about this",
            ),
            ("case-insensitive fillers", "UM this is UH a test", "this is a test"),
            (
                "punctuated fillers",
                "Well, um, I think, uh. that's right",
                "Well, I think, that's right",
            ),
            ("repeated whitespace", "Hello    world   test", "Hello world test"),
            ("outer whitespace", "  Hello world  ", "Hello world"),
            (
                "combined cleanup",
                "  Um, so I was, uh, thinking about this  ",
                "so I was, thinking about this",
            ),
            (
                "valid text",
                "This is a completely normal sentence.",
                "This is a completely normal sentence.",
            ),
            (
                "partial ASR prompt leak",
                "And right now my mortgage is like $1.3 million, $7. The speaker may be quiet, fast, or mumbled. If speech is present, transcribe the spoken words verbatim with normal punctuation. I've been working on this for a while now.",
                "And right now my mortgage is like $1.3 million, $7. I've been working on this for a while now.",
            ),
            (
                "full ASR prompt leak",
                "Before. Transcribe short desktop dictation accurately. The speaker may be quiet, fast, or mumbled. If speech is present, transcribe the spoken words verbatim with normal punctuation. Preserve spoken filler words and hesitation sounds such as um, uh, uhm, and uhh. After.",
                "Before. After.",
            ),
            (
                "long stutter",
                "w wh wh wh wh wh wh wh wh wh why",
                "w wh why",
            ),
            ("short-word stutter", "I I I I think so so so so", "I think so"),
            ("mixed-case stutter", "No NO no NO no", "No"),
            ("two repetitions are speech", "no no is fine", "no no is fine"),
        ];

        for (name, input, expected) in cases {
            assert_eq!(filter_transcription_output(input), expected, "case: {name}");
        }
    }
}
