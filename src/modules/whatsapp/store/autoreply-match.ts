/**
 * Keyword matching for auto-replies.
 *
 * Before this, EXACT compared the raw lower-cased text, so "Price?" or "price " never matched the
 * keyword "price", CONTAINS was a plain substring test and STARTS_WITH (offered in the UI) had no
 * implementation at all — those rules silently never fired. People do not type keywords exactly:
 * they add punctuation, emojis, greetings and typos. Matching now works on a normalised form of
 * both sides and supports several alternatives per rule ("price | rate | cost").
 *
 * Match types
 *   SMART        (default for new rules) every word of the keyword must appear in the message,
 *                in any order, tolerating typos (1 edit for words of 5+ letters, 2 for 8+) and
 *                plural/suffix forms ("price" ~ "prices"). "hi" still needs the word "hi".
 *   EXACT        the whole message equals the keyword (after normalisation)
 *   CONTAINS     the keyword appears as a whole-word phrase anywhere in the message
 *   STARTS_WITH  the message begins with the keyword
 *   REGEX        JavaScript regular expression, case-insensitive, on the original text
 */

export type MatchType = "SMART" | "EXACT" | "CONTAINS" | "STARTS_WITH" | "REGEX";

export const MATCH_TYPES: MatchType[] = ["SMART", "EXACT", "CONTAINS", "STARTS_WITH", "REGEX"];

/** Lower-case, strip punctuation/emoji/diacritics, collapse whitespace. */
export function normalizeText(input: string): string {
    return input
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")          // combining marks (é → e)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")       // anything that is not a letter, digit or space
        .replace(/\s+/g, " ")
        .trim();
}

/** "price | rate, cost" → ["price", "rate", "cost"] (normalised, empty ones dropped). */
export function keywordAlternatives(keyword: string): string[] {
    return keyword
        .split(/[|,\n]/)
        .map(normalizeText)
        .filter(Boolean);
}

function levenshtein(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let left = i;
        let rowMin = left;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const cur = Math.min(prev[j] + 1, left + 1, prev[j - 1] + cost);
            prev[j - 1] = left;
            left = cur;
            rowMin = Math.min(rowMin, cur);
        }
        prev[b.length] = left;
        if (rowMin > max) return max + 1;
    }
    return prev[b.length];
}

/** Does the message word count as the keyword word? Equal, suffix form, or a small typo. */
function wordMatches(keywordWord: string, messageWord: string): boolean {
    if (keywordWord === messageWord) return true;
    const n = keywordWord.length;
    if (n < 4) return false;                                              // "hi", "ok", "yes": exact only
    if (messageWord.startsWith(keywordWord) && messageWord.length - n <= 3) return true; // price → prices, pricing
    const tolerance = n >= 8 ? 2 : n >= 5 ? 1 : 0;
    return tolerance > 0 && levenshtein(keywordWord, messageWord, tolerance) <= tolerance;
}

/** Whole-word phrase containment: "hi" is found in "hi there" but not in "him" or "this". */
function containsPhrase(normalizedMessage: string, phrase: string): boolean {
    return ` ${normalizedMessage} `.includes(` ${phrase} `);
}

function smartMatch(alternative: string, normalizedMessage: string, messageWords: string[]): boolean {
    if (containsPhrase(normalizedMessage, alternative)) return true;
    const words = alternative.split(" ");
    return words.every(kw => messageWords.some(mw => wordMatches(kw, mw)));
}

export function matchAutoReply(rule: { keyword: string; matchType?: string | null }, text: string): boolean {
    if (!text) return false;
    const type = (rule.matchType || "SMART").toUpperCase();

    if (type === "REGEX") {
        try {
            return new RegExp(rule.keyword, "i").test(text);
        } catch {
            return false;
        }
    }

    const message = normalizeText(text);
    if (!message) return false;
    const alternatives = keywordAlternatives(rule.keyword);
    if (alternatives.length === 0) return false;
    const messageWords = message.split(" ");

    return alternatives.some(alt => {
        switch (type) {
            case "EXACT": return message === alt;
            case "CONTAINS": return containsPhrase(message, alt);
            case "STARTS_WITH": return message === alt || message.startsWith(alt + " ");
            default: return smartMatch(alt, message, messageWords);
        }
    });
}
