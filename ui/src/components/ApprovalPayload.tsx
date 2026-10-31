import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { ApprovalSectionLabel } from "./ApprovalSectionLabel";
import { formatCents } from "../lib/utils";
import { approvalReadableText } from "../lib/approval-readable-text";
import { approvalCost, approvalDecideBy, decideByState, decideByText, formatApprovalCost, formatDecideBy } from "../lib/approval-terms";

export { approvalReadableText };

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  request_board_approval: "Board Approval",
};

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function uniqueStrings(...values: unknown[]): string[] {
  const items = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
  const seen = new Set<string>();

  return items.flatMap((value) => {
    if (typeof value !== "string") return [];
    const item = value.trim();
    const key = item.toLocaleLowerCase();
    if (!item || seen.has(key)) return [];
    seen.add(key);
    return [item];
  });
}

export function approvalDecisionBrief(payload?: Record<string, unknown> | null) {
  return {
    recommendation: firstNonEmptyString(
      payload?.recommendedAction,
      payload?.recommendation,
      payload?.proposedAction,
    ),
    reasoning: firstNonEmptyString(
      payload?.reasoning,
      payload?.rationale,
      payload?.justification,
      payload?.decisionReasoning,
      payload?.summary,
      payload?.intent,
      payload?.guidance,
      payload?.description,
      payload?.strategy,
      payload?.plan,
      payload?.capabilities,
    ),
    pros: uniqueStrings(
      payload?.pros,
      payload?.benefits,
      payload?.reasonsToApprove,
      payload?.advantages,
      payload?.upside,
    ),
    cons: uniqueStrings(
      payload?.cons,
      payload?.risks,
      payload?.riskAssessment,
      payload?.brandRiskAssessment,
      payload?.reasonsNotToApprove,
      payload?.tradeoffs,
      payload?.drawbacks,
      payload?.downside,
    ),
    nextAction: firstNonEmptyString(payload?.nextActionOnApproval),
  };
}

export type ApprovalOriginalRequest = {
  text: string;
  source: {
    kind: "paperclip_comment" | "external";
    commentId?: string;
    issueId?: string;
    sender?: string;
    sentAt?: string;
    reference?: string;
    channel?: string;
    snapshotOrigin?: "server" | "requester";
  };
};

export function approvalOriginalRequest(
  payload?: Record<string, unknown> | null,
): ApprovalOriginalRequest | null {
  const value = payload?.originalRequest;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (typeof record.text !== "string" || record.text.length === 0) return null;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const sourceRecord = source as Record<string, unknown>;
  if (sourceRecord.kind !== "paperclip_comment" && sourceRecord.kind !== "external") {
    return null;
  }
  const optionalString = (key: string) =>
    typeof sourceRecord[key] === "string" && sourceRecord[key] ? String(sourceRecord[key]) : undefined;
  return {
    text: record.text,
    source: {
      kind: sourceRecord.kind,
      commentId: optionalString("commentId"),
      issueId: optionalString("issueId"),
      sender: optionalString("sender"),
      sentAt: optionalString("sentAt"),
      reference: optionalString("reference"),
      channel: optionalString("channel"),
      snapshotOrigin:
        sourceRecord.snapshotOrigin === "server"
          ? "server"
          : sourceRecord.snapshotOrigin === "requester"
            ? "requester"
            : undefined,
    },
  };
}

/**
 * An English translation the requesting agent attached, of the received email
 * or of the draft. `language` is the language of the text it translates, when
 * the agent named one the interface knows.
 */
export type ApprovalTranslation = {
  text: string;
  language: string | null;
  /**
   * Set by approvalTranslationFor when the agent named a language the text it
   * translates is plainly not written in ("Chinese" for an English draft): the
   * translation may belong to another version of that text.
   */
  mismatchedLanguage?: string;
};

/**
 * Bidi marks and controls (Arabic letter mark, left-to-right and right-to-left marks, embeddings, overrides,
 * isolates): they can make text read in another order than it is written ("100-500" as "500-100").
 */
const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Invisible format characters (zero-width spaces, joiners, bidi controls): text made only of them shows nothing. */
const FORMAT_CHARACTER_PATTERN = /\p{Cf}/gu;
const LANGUAGE_INPUT_MAX_LENGTH = 60;
/** A language name with its qualifiers: "Chinese (Traditional, Hong Kong)". */
const LANGUAGE_NAME_PARTS_PATTERN = /^([^()]+?)\s*(?:\(([^()]+)\))?$/u;
/** A language tag as agents write one: "zh", "zh-CN", "pt-BR", "zh-Hans". */
const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
/** Two-letter tags that are also English words an agent may write in lower case: never read as a language. */
const LANGUAGE_TAG_WORDS = new Set(["am", "an", "as", "be", "is", "my", "na", "no", "ok", "or", "so", "to"]);
/** Languages agents name that have no two-letter code. */
const EXTRA_LANGUAGE_CODES = ["fil", "yue", "ceb", "hmn", "haw", "ckb"];
/** Tags whose English name is not the base language's: "Simplified Chinese", "Brazilian Portuguese". */
const LANGUAGE_VARIANT_TAGS = ["zh-Hans", "zh-Hant", "pt-BR", "pt-PT", "es-MX", "es-419", "fr-CA", "en-GB", "en-US", "nl-BE"];
/** Names in their own language that agents copy from an email ("Русский", "日本語"): shown in English. */
const AUTONYM_TAGS = [
  "zh", "zh-Hans", "zh-Hant", "ja", "ko", "ru", "uk", "bg", "sr", "mk", "be", "kk", "ar", "fa", "ur", "he", "th", "lo",
  "km", "my", "hi", "bn", "pa", "gu", "ta", "te", "kn", "ml", "mr", "ne", "si", "el", "ka", "hy", "am", "mn", "vi",
  "es", "fr", "de", "pt", "it", "nl", "tr", "pl", "id", "ms",
];
/** Other English names agents use, with the tag that gives their script. */
const LANGUAGE_ALIASES: Array<[string, string]> = [
  ["Mandarin", "zh"],
  ["Farsi", "fa"],
  ["Tagalog", "fil"],
  ["Serbo-Croatian", "hr"],
  ["Flemish", "nl"],
  ["Castilian", "es"],
];
/** Scripts that may qualify a language name: "Serbian (Latin)", "Chinese (Simplified)". */
const QUALIFIER_SCRIPT_CODES = [
  "Hans", "Hant", "Latn", "Cyrl", "Arab", "Hebr", "Deva", "Beng", "Thai", "Grek", "Geor", "Armn", "Jpan", "Kore", "Hang",
];
/** Spoken forms that may qualify "Chinese". */
const QUALIFIER_WORDS = ["Mandarin", "Cantonese", "Simplified", "Traditional"];
/**
 * Region codes that name no place a language is spoken in: unknown and private-use
 * codes, pseudo-locales ("Pseudo-Accents"), groupings ("European Union", "United Nations").
 * XK stays: it is Kosovo.
 */
const NON_REGION_CODE_PATTERN = /^(?:AA|Q[M-Z]|X[A-JL-Z]|ZZ|EU|EZ|UN)$/;
/** Languages also written in Latin letters every day (Serbian, romanized Hindi): their script says nothing about a text. */
const ALSO_LATIN_LANGUAGES = new Set(["sr", "bs", "hi", "ur", "pa", "kk", "uz", "az", "tk", "mn"]);

/**
 * A known language, in English. `script` is its usual script (ISO 15924: "Latn",
 * "Hans", "Jpan", "Cyrl"), null when unknown or when it is often written in two.
 */
type LanguageEntry = { name: string; script: string | null };
/** A qualifier; `script` is set when it names a script ("Latin", "Cyrillic"). */
type LanguageQualifier = { name: string; script: string | null };

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
let languageNames: Map<string, LanguageEntry> | null | undefined;
let languageQualifiers: Map<string, LanguageQualifier> | null | undefined;

function tagScript(tag: string): string | null {
  try {
    const locale = new Intl.Locale(tag);
    if (!locale.script && ALSO_LATIN_LANGUAGES.has(locale.language)) return null;
    return locale.maximize().script ?? null;
  } catch {
    return null;
  }
}

/**
 * The language names the interface accepts, from the browser's own language
 * data (built once, on first use). Null where that data is missing: no name is
 * then shown.
 */
function getLanguageNames(): Map<string, LanguageEntry> | null {
  if (languageNames !== undefined) return languageNames;
  try {
    const languageName = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
    const languages = new Map<string, LanguageEntry>();
    const add = (name: string | undefined, entry: LanguageEntry) => {
      if (name && !languages.has(name.toLowerCase())) languages.set(name.toLowerCase(), entry);
    };
    const codes = [...EXTRA_LANGUAGE_CODES];
    for (const first of LETTERS) for (const second of LETTERS) codes.push(first + second);
    for (const tag of [...codes, ...LANGUAGE_VARIANT_TAGS]) {
      const name = languageName.of(tag);
      if (name && name.toLowerCase() !== tag.toLowerCase()) add(name, { name, script: tagScript(tag) });
    }
    for (const [name, tag] of LANGUAGE_ALIASES) add(name, { name, script: tagScript(tag) });
    for (const tag of AUTONYM_TAGS) {
      const english = languageName.of(tag);
      if (!english) continue;
      add(new Intl.DisplayNames([tag], { type: "language", fallback: "none" }).of(tag), { name: english, script: tagScript(tag) });
    }
    languageNames = languages;
  } catch {
    languageNames = null;
  }
  return languageNames;
}

/** The qualifiers a language name may carry in parentheses: a script, a region, a spoken form. Built on first use. */
function getLanguageQualifiers(): Map<string, LanguageQualifier> | null {
  if (languageQualifiers !== undefined) return languageQualifiers;
  try {
    const qualifiers = new Map<string, LanguageQualifier>();
    const addQualifier = (name: string | undefined, script: string | null) => {
      if (name && !qualifiers.has(name.toLowerCase())) qualifiers.set(name.toLowerCase(), { name, script });
    };
    const scriptName = new Intl.DisplayNames(["en"], { type: "script", fallback: "none" });
    for (const code of QUALIFIER_SCRIPT_CODES) addQualifier(scriptName.of(code), code);
    for (const word of QUALIFIER_WORDS) addQualifier(word, null);
    for (const style of ["long", "short"] as const) {
      const regionName = new Intl.DisplayNames(["en"], { type: "region", fallback: "none", style });
      for (const first of LETTERS) {
        for (const second of LETTERS) {
          const code = `${first}${second}`.toUpperCase();
          if (!NON_REGION_CODE_PATTERN.test(code)) addQualifier(regionName.of(code), null);
        }
      }
    }
    languageQualifiers = qualifiers;
  } catch {
    languageQualifiers = null;
  }
  return languageQualifiers;
}

/**
 * Reads the agent's language name: kept only when it names a language the
 * interface knows ("Chinese (Simplified)", "Russian", "zh-CN"), in its English
 * form, with the script that language is written in. It is shown
 * beside the interface's own labels, so a claim ("Board approved",
 * "Chinese (verified)") or a placeholder ("Unknown", "Same as original") must
 * never pass for one.
 */
function readLanguage(value: unknown): LanguageEntry | null {
  if (typeof value !== "string") return null;
  const input = value.replace(FORMAT_CHARACTER_PATTERN, "").replace(/\s+/g, " ").trim();
  if (!input || input.length > LANGUAGE_INPUT_MAX_LENGTH) return null;
  const languages = getLanguageNames();
  if (!languages) return null;
  if (LANGUAGE_TAG_PATTERN.test(input) && !LANGUAGE_TAG_WORDS.has(input)) {
    try {
      const name = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(input);
      const base = name ? languages.get(name.replace(/\s*\(.*$/, "").toLowerCase()) : undefined;
      if (name && base) return { name, script: tagScript(input) };
    } catch {
      // Not a well-formed tag: read it as a name below.
    }
  }
  const parts = LANGUAGE_NAME_PARTS_PATTERN.exec(input);
  const base = parts ? languages.get(parts[1].toLowerCase()) : undefined;
  if (!parts || !base) return null;
  if (!parts[2]) return base;
  const known = getLanguageQualifiers();
  if (!known) return null;
  const qualifiers = parts[2].split(",").map((part) => known.get(part.trim().toLowerCase()));
  if (qualifiers.some((qualifier) => !qualifier)) return null;
  const script = qualifiers.find((qualifier) => qualifier!.script !== null);
  return {
    name: `${base.name} (${qualifiers.map((qualifier) => qualifier!.name).join(", ")})`,
    script: script ? script.script : base.script,
  };
}

/**
 * Reads one translation field: `{ text, language }`, or the text alone (the
 * language is then unknown). Text that is empty, only white space or only
 * invisible characters is no translation. The text is kept as written, line
 * breaks included, without bidi marks or controls: a translation into English needs none.
 */
export function approvalTranslation(value: unknown): ApprovalTranslation | null {
  const record =
    typeof value === "string"
      ? { text: value }
      : value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
  if (!record || typeof record.text !== "string") return null;
  if (!record.text.replace(FORMAT_CHARACTER_PATTERN, "").trim()) return null;
  return { text: record.text.replace(BIDI_CONTROL_PATTERN, ""), language: readLanguage(record.language)?.name ?? null };
}

/** The English translation of the received email (`originalRequest.translation`). */
export function approvalOriginalRequestTranslation(
  payload?: Record<string, unknown> | null,
): ApprovalTranslation | null {
  const value = payload?.originalRequest;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return approvalTranslation((value as Record<string, unknown>).translation);
}

/** The English translation of the outgoing draft (`bodyTranslation`). The executor never sends it. */
export function approvalDraftTranslation(payload?: Record<string, unknown> | null): ApprovalTranslation | null {
  return approvalTranslation(payload?.bodyTranslation);
}

/** "English", "British English", "English (United States)": the language the board reads. */
const ENGLISH_NAME_PATTERN = /\benglish\b/i;

/**
 * The translation as shown under `source`, the text it translates. "English",
 * in any form, is dropped without a word: "translated from English" is no
 * claim to show, and agents often name the translation's own language there.
 * A language the text is plainly not written in ("Chinese" for a draft in
 * Latin letters, "Korean" for a Japanese one, "Spanish" for a Russian one) is
 * dropped too, and kept in `mismatchedLanguage`: the translation may belong to
 * another version of the text, and the board is told so.
 */
export function approvalTranslationFor(
  translation: ApprovalTranslation | null,
  source: string,
): ApprovalTranslation | null {
  if (!translation?.language) return translation;
  const language = readLanguage(translation.language);
  if (!language || ENGLISH_NAME_PATTERN.test(language.name)) return { ...translation, language: null };
  if (languageFitsText(language, source)) return translation;
  return { ...translation, language: null, mismatchedLanguage: language.name };
}

/** Letters (weighted, see weigh) a text needs before its script is judged: a greeting or a name alone says nothing. */
const SCRIPT_MIN_LETTERS = 8;
/** The share of letters outside the Latin script above which a text is taken as not English. */
const NON_LATIN_SHARE = 0.3;
/** Where a quoted thread is looked for: past this a message is not read. */
const SCRIPT_SCAN_LENGTH = 200_000;
/** A very long text is judged on its start and its end, this much of each. */
const SCRIPT_SAMPLE_PART = 10_000;
const LETTER_PATTERN = /\p{L}/gu;
/** A letter that is not a Latin one. */
const NON_LATIN_LETTER_PATTERN = /(?=\p{L})\P{Script=Latin}/gu;
/** Scripts in which one character carries about a word: each counts as this many Latin letters. */
const WORD_SCRIPT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD_SCRIPT_WEIGHT = 3;
const HAN_PATTERN = /\p{Script=Han}/gu;
const KANA_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HANGUL_PATTERN = /\p{Script=Hangul}/gu;
/** Japanese prose is at least this share kana; Chinese has none. */
const JAPANESE_KANA_SHARE = 0.1;
/** The other scripts a language may be named for, by their ISO 15924 code. */
const TEXT_SCRIPTS: Array<[string, RegExp]> = [
  ["Cyrl", /\p{Script=Cyrillic}/gu],
  ["Arab", /\p{Script=Arabic}/gu],
  ["Hebr", /\p{Script=Hebrew}/gu],
  ["Thai", /\p{Script=Thai}/gu],
  ["Deva", /\p{Script=Devanagari}/gu],
  ["Beng", /\p{Script=Bengali}/gu],
  ["Grek", /\p{Script=Greek}/gu],
  ["Geor", /\p{Script=Georgian}/gu],
  ["Armn", /\p{Script=Armenian}/gu],
  ["Ethi", /\p{Script=Ethiopic}/gu],
  ["Khmr", /\p{Script=Khmer}/gu],
  ["Laoo", /\p{Script=Lao}/gu],
  ["Mymr", /\p{Script=Myanmar}/gu],
  ["Sinh", /\p{Script=Sinhala}/gu],
  ["Taml", /\p{Script=Tamil}/gu],
  ["Telu", /\p{Script=Telugu}/gu],
  ["Knda", /\p{Script=Kannada}/gu],
  ["Mlym", /\p{Script=Malayalam}/gu],
  ["Gujr", /\p{Script=Gujarati}/gu],
  ["Guru", /\p{Script=Gurmukhi}/gu],
  ["Orya", /\p{Script=Oriya}/gu],
  ["Tibt", /\p{Script=Tibetan}/gu],
  ["Thaa", /\p{Script=Thaana}/gu],
  ["Mong", /\p{Script=Mongolian}/gu],
];
/** The text scripts each Chinese, Japanese or Korean language script is written in (see mainScript). */
const WORD_LANGUAGE_SCRIPTS: Record<string, string[]> = {
  Hans: ["Hani"],
  Hant: ["Hani"],
  Hani: ["Hani"],
  // Japanese may be written in kanji alone.
  Jpan: ["Jpan", "Hani"],
  Kore: ["Kore"],
  Hang: ["Kore"],
};
/**
 * A link or an email address, in ASCII only: text in another script often runs on with no space after one.
 * Linear on any input: an address may only start where a run of address characters starts, and every part is bounded.
 */
const ADDRESS_PATTERN =
  /(?:https?:\/\/|www\.)[!-~]+|(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/giu;

function countOf(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Letters, without links and addresses. */
function letterCount(text: string): number {
  return countOf(text.replace(ADDRESS_PATTERN, " "), LETTER_PATTERN);
}

type ScriptWeight = { letters: number; nonLatin: number };

/**
 * A text's letters and those outside the Latin script, a Chinese, Japanese or
 * Korean character counted as a short word. Links, addresses, digits and
 * punctuation are not counted. A very long text is weighed on its start and end.
 */
function weigh(text: string): ScriptWeight {
  let sample = text;
  if (sample.length > SCRIPT_SAMPLE_PART * 2) {
    sample = `${sample.slice(0, SCRIPT_SAMPLE_PART)}\n${sample.slice(-SCRIPT_SAMPLE_PART)}`;
  }
  sample = sample.replace(ADDRESS_PATTERN, " ");
  const extra = countOf(sample, WORD_SCRIPT_PATTERN) * (WORD_SCRIPT_WEIGHT - 1);
  return { letters: countOf(sample, LETTER_PATTERN) + extra, nonLatin: countOf(sample, NON_LATIN_LETTER_PATTERN) + extra };
}

function judge(weight: ScriptWeight): "latin" | "non-latin" | null {
  if (weight.letters < SCRIPT_MIN_LETTERS) return null;
  return weight.nonLatin / weight.letters > NON_LATIN_SHARE ? "non-latin" : "latin";
}

/**
 * Where the quoted thread under a reply starts: "On … wrote:" (one or two lines), "… wrote:",
 * "-----Original Message-----", Gmail's "… 写道：", Outlook's rule of underscores, or a
 * "From:" line followed by "Sent:" or "Date:".
 */
function isQuoteHeader(lines: string[], index: number): boolean {
  const line = lines[index];
  if (/^-{2,} ?Original Message ?-{2,}$/i.test(line) || /^_{10,}$/.test(line)) return true;
  if (line.length <= 200 && (/写道[:：]$/u.test(line) || /\bwrote:$/i.test(line))) return true;
  if (/^On\s/i.test(line) && line.length <= 200 && (lines[index + 1] ?? "").endsWith("wrote:")) return true;
  if (/^(?:From|发件人|寄件者) ?[:：]/iu.test(line)) {
    return lines.slice(index + 1, index + 4).some((next) => /^(?:Sent|Date|发送时间|日期|寄件日期) ?[:：]/iu.test(next));
  }
  return false;
}

/**
 * The part of a message its writer wrote now: the lines above the quoted
 * thread (lines starting with ">", or everything after a quote header or a
 * "--" signature line). A header with nothing written above it starts a
 * message pasted whole, so it is passed over.
 */
function newMessagePart(text: string): string {
  const lines = text.slice(0, SCRIPT_SCAN_LENGTH).split("\n").map((line) => line.trim());
  const kept: string[] = [];
  let keptLetters = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith(">") || line.startsWith("＞")) continue;
    if (line === "--" || isQuoteHeader(lines, index)) {
      if (keptLetters >= SCRIPT_MIN_LETTERS) break;
      continue;
    }
    kept.push(line);
    if (keptLetters < SCRIPT_MIN_LETTERS) keptLetters += weigh(line).letters;
  }
  return kept.join("\n");
}

/**
 * The script most of a text's other letters are in: an ISO 15924 code from
 * TEXT_SCRIPTS, or for Chinese, Japanese and Korean "Hani" (Han alone), "Jpan"
 * (Han with kana) or "Kore" (mostly Hangul). Null when it has none of these.
 */
function mainScript(text: string): string | null {
  const sample = text.slice(0, SCRIPT_SAMPLE_PART * 2);
  const han = countOf(sample, HAN_PATTERN);
  const kana = countOf(sample, KANA_PATTERN);
  const hangul = countOf(sample, HANGUL_PATTERN);
  let main: string | null = null;
  let mainCount = han + kana + hangul;
  if (mainCount > 0) main = hangul > han + kana ? "Kore" : kana >= (han + kana) * JAPANESE_KANA_SHARE ? "Jpan" : "Hani";
  for (const [code, pattern] of TEXT_SCRIPTS) {
    const count = countOf(sample, pattern);
    if (count > mainCount) [main, mainCount] = [code, count];
  }
  return main;
}

type ScriptReading = {
  script: "latin" | "non-latin" | null;
  /** The new part of the message or the whole of it reads as Latin letters. */
  latinPart: boolean;
  /** The weighted letters of the part read as not Latin (the new part first), or of the whole text. */
  weightedLetters: number;
};
const SCRIPT_CACHE_SIZE = 256;
const scriptCache = new Map<string, ScriptReading>();

/**
 * Reads a text's script once: it is judged on every render of every queue row,
 * up to four times per card. A text is not in Latin letters when its new part
 * (see newMessagePart) is not, or the text as a whole is not: a Chinese reply
 * above a long English thread, and a Chinese email forwarded under a line of
 * English, both need a translation.
 */
function readScript(text: string): ScriptReading {
  const cached = scriptCache.get(text);
  if (cached) return cached;
  const whole = weigh(text);
  const part = newMessagePart(text);
  const fresh = part.length === text.length ? whole : weigh(part);
  const [wholeScript, freshScript] = [judge(whole), judge(fresh)];
  const nonLatin = freshScript === "non-latin" || wholeScript === "non-latin";
  const latinPart = freshScript === "latin" || wholeScript === "latin";
  const reading: ScriptReading = {
    script: nonLatin ? "non-latin" : latinPart ? "latin" : null,
    latinPart,
    weightedLetters: freshScript === "non-latin" ? fresh.letters : whole.letters,
  };
  if (scriptCache.size >= SCRIPT_CACHE_SIZE) scriptCache.clear();
  scriptCache.set(text, reading);
  return reading;
}

/**
 * Whether `text` may be written in `language`. Only a plain contradiction
 * counts: a language in Latin letters for a text that has no part in them,
 * another for a text in Latin letters, or one in another script than the
 * text's ("Korean" for Japanese). A language or a text whose script is not
 * known may be anything.
 */
function languageFitsText(language: LanguageEntry, text: string): boolean {
  const reading = readScript(text);
  if (!language.script || !reading.script) return true;
  if (language.script === "Latn") return reading.latinPart;
  if (reading.script === "latin") return false;
  const fits = WORD_LANGUAGE_SCRIPTS[language.script] ?? [language.script];
  if (!WORD_LANGUAGE_SCRIPTS[language.script] && !TEXT_SCRIPTS.some(([code]) => code === language.script)) return true;
  const main = mainScript(text.replace(ADDRESS_PATTERN, " "));
  return main === null || fits.includes(main);
}

/**
 * Whether a text is written mostly outside the Latin script (Chinese,
 * Japanese, Korean, Cyrillic, Arabic, Hebrew, Thai, Devanagari, ...), so a
 * board that reads English needs a translation: its new part, or the whole
 * of it (see readScript). Links and addresses are left out, and so are
 * digits and punctuation, which are not letters; a Chinese, Japanese or Korean
 * character weighs as much as a short word. A signature or a quote in another
 * script can tip an English text over: the board then asks for a translation
 * it does not need, which costs less than one it needed and never got. A
 * language written in Latin letters (Spanish, German) cannot be told from
 * English this way and is never flagged.
 */
export function isMostlyNonLatinScript(text: string): boolean {
  return readScript(text).script === "non-latin";
}

/** A translation shorter than this share of the English the source would give looks cut. */
const TRANSLATION_MIN_SHARE = 0.4;
/** Below this many (weighted) letters a source is too short to estimate. */
const TRANSLATION_ESTIMATE_MIN_LETTERS = 80;

/**
 * Whether a translation of a text in another script looks much shorter than a
 * full one: its letters against those of the part of the source not in Latin
 * letters (see readScript), a Chinese, Japanese or Korean character counted as
 * a short word. A hint only; it cannot tell a summary from a terse translation.
 */
export function approvalTranslationLooksShort(translation: ApprovalTranslation, source: string): boolean {
  const reading = readScript(source);
  if (reading.script !== "non-latin" || reading.weightedLetters < TRANSLATION_ESTIMATE_MIN_LETTERS) return false;
  return letterCount(translation.text) < reading.weightedLetters * TRANSLATION_MIN_SHARE;
}

const translationLabelClass =
  "break-words text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground";

/** What the board must keep in mind about any translation it reads on a request. */
export const APPROVAL_TRANSLATION_NOTE =
  "Translated by the requesting agent. Check it against the original before approving.";

/** The label of a translation sub-block, with the language it was made from when known. Text, not color. */
export function ApprovalTranslationLabel({
  label,
  translation,
  languageLead,
}: {
  label: string;
  translation: ApprovalTranslation;
  /** Words before the language: "from" for the received email, "written in" for the draft. */
  languageLead: string;
}) {
  return (
    <>
      <p className={translationLabelClass}>
        {label}
        {translation.language && (
          <span className="normal-case tracking-normal">
            {" · "}
            {languageLead} {translation.language}
          </span>
        )}
      </p>
      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{APPROVAL_TRANSLATION_NOTE}</p>
    </>
  );
}

/** The language a draft is written in, as the requesting agent named it, beside its label. */
export function ApprovalDraftLanguageChip({ language }: { language: string | null }) {
  if (!language) return null;
  return (
    <span
      className="min-w-0 break-words rounded bg-muted px-1.5 py-0.5 text-(length:--text-micro) font-medium text-foreground/80"
      title="Language named by the requesting agent"
      data-approval-draft-language=""
    >
      <span className="sr-only">Written in </span>
      {language}
    </span>
  );
}

const MISSING_TRANSLATION_TEXT = {
  missing: "Not in English and no translation attached. Request a revision to get one.",
  // The server saves a Paperclip comment as posted and keeps nothing else with it, so a revision cannot add one.
  comment: "Not in English. A Paperclip comment is saved as posted, so no translation can be attached.",
  "not-english": "The attached translation is not in English. Request a revision to get one.",
  short: "The translation looks much shorter than the original. Request a revision if parts are missing.",
  // Written with the language and the text's name (see approvalTranslationMismatchText).
  mismatch: "",
} as const;

const MISSING_TRANSLATION_ATTRIBUTE: Record<keyof typeof MISSING_TRANSLATION_TEXT, string> = {
  missing: "data-approval-translation-missing",
  comment: "data-approval-translation-missing",
  "not-english": "data-approval-translation-not-english",
  short: "data-approval-translation-short",
  mismatch: "data-approval-translation-mismatch",
};

/** Said under a translation whose named language the text it translates is not written in. */
export function approvalTranslationMismatchText(language: string, noun: string): string {
  return `The agent says the ${noun} is in ${language}, but it is not. The translation may not match it. Request a revision.`;
}

/**
 * Shown under a received email or a draft that is not in English and carries
 * no translation, or under a translation that is not in English itself, looks
 * cut, or names a language its source is not in.
 */
export function ApprovalMissingTranslationNote({
  of,
  reason = "missing",
  text,
}: {
  of: "original" | "draft";
  reason?: keyof typeof MISSING_TRANSLATION_TEXT;
  /** The note's text, where the reason's own needs the details (a mismatch). */
  text?: string;
}) {
  return (
    <p
      className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300"
      {...{ [MISSING_TRANSLATION_ATTRIBUTE[reason]]: of }}
    >
      {text ?? MISSING_TRANSLATION_TEXT[reason]}
    </p>
  );
}

/**
 * What is wrong with a translation of `source`, under it: a named language the
 * source is not in, and not in English or much shorter than the source.
 */
function ApprovalTranslationNotes({
  of,
  noun,
  translation,
  source,
}: {
  of: "original" | "draft";
  /** What the source is called on the card: "draft", "original email". */
  noun: string;
  translation: ApprovalTranslation;
  source: string;
}) {
  const reason = isMostlyNonLatinScript(translation.text)
    ? "not-english"
    : approvalTranslationLooksShort(translation, source)
      ? "short"
      : null;
  return (
    <>
      {translation.mismatchedLanguage && (
        <ApprovalMissingTranslationNote
          of={of}
          reason="mismatch"
          text={approvalTranslationMismatchText(translation.mismatchedLanguage, noun)}
        />
      )}
      {reason && <ApprovalMissingTranslationNote of={of} reason={reason} />}
    </>
  );
}

/** The frame of a translation: a rule on its left, so it reads as part of the block above it and not as a block of its own. */
const APPROVAL_TRANSLATION_FRAME_CLASS = "mt-3 min-w-0 scroll-mt-20 border-l-2 border-border pl-3";

/**
 * Under a draft: its English translation, or a warning when the draft is not
 * in English and has none. The translation's box is dashed, unlike the solid
 * frame of the draft that is sent, and marked inside so it says what it is
 * when its label has scrolled away. A compact surface passes the `shown` part
 * and a `continues` line when it cuts the translation. Never sent: the executor
 * sends the draft and nothing else.
 */
export function ApprovalDraftTranslation({
  translation,
  draft,
  shown,
  continues,
}: {
  translation: ApprovalTranslation | null;
  /** The draft that is sent, which the translation translates. */
  draft: string;
  /** The part of the translation shown; the whole of it by default. */
  shown?: string;
  continues?: ReactNode;
}) {
  if (!translation) return isMostlyNonLatinScript(draft) ? <ApprovalMissingTranslationNote of="draft" /> : null;
  return (
    <div data-approval-translation="draft" className={APPROVAL_TRANSLATION_FRAME_CLASS}>
      <ApprovalTranslationLabel label="English translation of the draft" translation={translation} languageLead="written in" />
      <div className="mt-2 rounded-md border border-dashed border-muted-foreground/40 bg-muted/20 px-3.5 py-3">
        <p
          className="mb-1 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground"
          data-approval-draft-translation-marker=""
        >
          Translation · not sent
        </p>
        <pre
          className="whitespace-pre-wrap wrap-anywhere font-sans text-sm leading-6 text-foreground"
          data-approval-draft-translation-body=""
        >
          {shown ?? translation.text}
        </pre>
      </div>
      {continues}
      <ApprovalTranslationNotes of="draft" noun="draft" translation={translation} source={draft} />
    </div>
  );
}

/** Resolves an agent id to a display name; null or undefined when it is not known. */
type OriginalRequestSenderResolver = (agentId: string) => string | null | undefined;

/** The shape of an agent id. A user id is free text and, in practice, never this shape. */
const SENDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A local user id as the server writes them (`local-board`, `local-implicit-board`): one bare token, no address, no words. */
const LOCAL_USER_ID_PATTERN = /^local-[a-z0-9_-]+$/i;

/**
 * Who sent the original request, as a name the board can read. An id is
 * resolved to a name or left out, never printed.
 *
 * For a Paperclip comment the server stores the author's id: an agent id (a
 * UUID) or a board user's id (any other text). An agent is named from the
 * company's agents. A sender that is not a UUID is a board user and is shown as
 * "Board", the name the discussion list gives every non-agent author. A UUID
 * the agent list does not hold is left out: it may be an agent that has since
 * been removed, and calling its comment the Board's own instruction on the page
 * where the board decides whether to act on it would be wrong.
 *
 * A sender the requesting agent supplied for an external source is kept as
 * written (`local-pickup@shop.example` is an address, not an id) unless it is
 * a UUID or a bare local user id.
 */
export function approvalOriginalRequestSender(
  source: ApprovalOriginalRequest["source"],
  resolveAgentName?: OriginalRequestSenderResolver,
): string | null {
  const sender = source.sender?.trim();
  if (!sender) return null;
  const isAgentIdShaped = SENDER_ID_PATTERN.test(sender);
  const isComment = source.kind === "paperclip_comment";
  const isId = isComment || isAgentIdShaped || LOCAL_USER_ID_PATTERN.test(sender);
  if (!isId) return sender;
  const name = resolveAgentName?.(sender)?.trim();
  if (name) return name;
  if (sender === "local-board") return "Board";
  return isComment && !isAgentIdShaped ? "Board" : null;
}

/** The time a request was sent, to the minute. Null when the value is not a date. */
function originalRequestSentAt(sentAt: string | undefined): string | null {
  if (!sentAt) return null;
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function OriginalRequestBlock({
  payload,
  compact = false,
  resolveAgentName,
}: {
  payload?: Record<string, unknown> | null;
  compact?: boolean;
  /** Names the agent that wrote a Paperclip comment. Without it, or for an unknown agent id, no sender is shown; a board user is shown as Board. */
  resolveAgentName?: OriginalRequestSenderResolver;
}) {
  const original = approvalOriginalRequest(payload);
  const isEmail = isEmailReplyPayload(payload);
  if (!original) {
    // Compact surfaces state this once in their header line (approvalMissingSourceNote).
    if (compact) return null;
    if (isEmail) {
      return (
        <div>
          <ApprovalSectionLabel className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Original email
          </ApprovalSectionLabel>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            The requesting agent did not attach the email this reply answers. Ask the agent for it, or read it in the linked task if there is one.
          </p>
        </div>
      );
    }
    return (
      <div>
        <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
          Original request
        </p>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          No original request was attached to this approval.
        </p>
      </div>
    );
  }

  // "Original email" only when the source is an outside message; a reply drafted from a Paperclip comment keeps "Original request".
  const sourceLabel = isEmail && original.source.kind === "external" ? "Original email" : "Original request";
  const senderName = approvalOriginalRequestSender(original.source, resolveAgentName);
  const commentHref =
    original.source.kind === "paperclip_comment" && original.source.issueId && original.source.commentId
      ? `/issues/${original.source.issueId}#comment-${original.source.commentId}`
      : null;
  const sentAt = originalRequestSentAt(original.source.sentAt);
  const translation = approvalTranslationFor(approvalOriginalRequestTranslation(payload), original.text);
  const needsTranslation = !translation && isMostlyNonLatinScript(original.text);
  // What the board needs to know about the text below, not how it is stored.
  const sourceNote =
    original.source.kind === "external" && original.source.snapshotOrigin === "requester"
      ? "Quoted by the requesting agent, not verified"
      : original.source.kind === "paperclip_comment" && original.source.snapshotOrigin === "server"
        ? "Saved from the original comment"
        : null;
  const provenance: Array<{ key: string; node: ReactNode }> = [
    { key: "channel", node: original.source.kind === "external" ? original.source.channel : null },
    { key: "sender", node: senderName },
    { key: "sentAt", node: sentAt ? <time dateTime={original.source.sentAt}>{sentAt}</time> : null },
    // The comment link below replaces the raw comment reference.
    { key: "reference", node: commentHref ? null : original.source.reference },
    { key: "note", node: sourceNote },
    {
      key: "comment",
      node: commentHref ? (
        <Link to={commentHref} className="underline underline-offset-2 hover:text-foreground">
          View comment
        </Link>
      ) : null,
    },
  ].filter((part) => Boolean(part.node));

  const content = (
    <>
      <ApprovalSectionLabel className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        {sourceLabel}
      </ApprovalSectionLabel>
      {provenance.length > 0 && (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {provenance.map((part, index) => (
            <Fragment key={part.key}>
              {index > 0 ? " · " : ""}
              {part.node}
            </Fragment>
          ))}
        </p>
      )}
      <OriginalRequestText
        // A new source text starts collapsed again: a revision must not inherit "Show more" from the old one.
        key={original.text}
        text={original.text}
        // On the queue an email reply always shows at most six lines of the email it answers, with the rest
        // behind "Show more" (the button appears when the text really overflows); the request's own page shows
        // it whole. Other requests are previewed on compact surfaces, as before.
        collapsible={compact && (isEmail || isLongOriginalRequest(original.text))}
        measure={compact && isEmail}
        fallbackLong={isEmail ? isLongOriginalEmail(original.text) : true}
        previewLines={isEmail ? 6 : 4}
        expandLabel={isEmail ? "Show more" : undefined}
        subject={senderName && isEmail ? `${sourceLabel} from ${senderName}` : sourceLabel}
        // Incoming, unverified text: a clearly dashed frame, so it can never pass for the outgoing draft
        // below it (a thin solid frame with a muted Via/To/Subject header).
        boxClassName={isEmail ? "mt-2 rounded-md border border-dashed border-muted-foreground/40 p-3" : undefined}
      />
      {translation ? (
        // Right under the text it translates, behind its own label and a rule; previewed the same way.
        <div data-approval-translation="original" className={APPROVAL_TRANSLATION_FRAME_CLASS}>
          <ApprovalTranslationLabel label="English translation" translation={translation} languageLead="from" />
          <OriginalRequestText
            key={translation.text}
            text={translation.text}
            collapsible={compact && (isEmail || isLongOriginalRequest(translation.text))}
            measure={compact && isEmail}
            fallbackLong={isEmail ? isLongOriginalEmail(translation.text) : true}
            previewLines={isEmail ? 6 : 4}
            // Never the request's own wording: the two buttons must not read alike.
            expandLabel={
              isEmail ? "Show more" : `Show full translation (${translation.text.length.toLocaleString()} characters)`
            }
            subject={`English translation of the ${sourceLabel.toLowerCase()}`}
            boxClassName={isEmail ? "mt-2 rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 p-3" : undefined}
          />
          <ApprovalTranslationNotes
            of="original"
            noun={sourceLabel.toLowerCase()}
            translation={translation}
            source={original.text}
          />
        </div>
      ) : (
        needsTranslation && (
          <ApprovalMissingTranslationNote
            of="original"
            reason={original.source.kind === "paperclip_comment" ? "comment" : "missing"}
          />
        )
      )}
    </>
  );

  // Kept apart from the outgoing draft by its own label and a dashed frame. Never interpret the retained text as HTML.
  return (
    <div data-approval-original-request={isEmail ? "email" : "request"} className="min-w-0 scroll-mt-20">
      {content}
    </div>
  );
}

const ORIGINAL_REQUEST_PREVIEW_LENGTH = 480;
const ORIGINAL_REQUEST_PREVIEW_LINES = 16;

const ORIGINAL_EMAIL_PREVIEW_LENGTH = 600;
const ORIGINAL_EMAIL_PREVIEW_LINES = 6;

/** An original email this long shows its start, with the rest behind "Show more". */
function isLongOriginalEmail(text: string) {
  if (text.length > ORIGINAL_EMAIL_PREVIEW_LENGTH) return true;
  return text.split("\n").length > ORIGINAL_EMAIL_PREVIEW_LINES;
}

/** A request this long is previewed on compact surfaces, behind a button that states its size. */
function isLongOriginalRequest(text: string) {
  if (text.length > ORIGINAL_REQUEST_PREVIEW_LENGTH) return true;
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lines += 1;
    if (lines > ORIGINAL_REQUEST_PREVIEW_LINES) return true;
  }
  return false;
}

function OriginalRequestText({
  text,
  collapsible,
  measure = false,
  fallbackLong = true,
  previewLines = 4,
  expandLabel,
  subject = "Original request",
  boxClassName,
}: {
  text: string;
  collapsible: boolean;
  /** Decide whether "Show more" is needed from the rendered height, not from counting characters. */
  measure?: boolean;
  /** Used when the height cannot be measured (no layout, as in tests). */
  fallbackLong?: boolean;
  previewLines?: 4 | 6;
  /** The button text while collapsed; defaults to one that states the request's size. */
  expandLabel?: string;
  subject?: string;
  boxClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // Once opened, the button stays: collapsing must never take away the control that has keyboard focus.
  const [wasExpanded, setWasExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(fallbackLong);
  const textRef = useRef<HTMLPreElement>(null);
  const clamped = collapsible && !expanded;

  // Measured while clamped, again on every resize: a paragraph that fits six lines on a wide card can need
  // fifteen on a phone. Without layout (scrollHeight 0) the length rule stands.
  useLayoutEffect(() => {
    if (!measure || expanded) return;
    const element = textRef.current;
    if (!element) return;
    const check = () => {
      if (element.scrollHeight === 0) {
        setOverflowing(fallbackLong);
        return;
      }
      setOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    check();
    // The clamped box keeps its size when the text reflows inside it (a web font arriving late can add a
    // seventh line), so a resize alone is not enough: measure again once fonts finish loading too.
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    let live = true;
    fonts?.ready?.then(() => {
      if (live) check();
    });
    fonts?.addEventListener?.("loadingdone", check);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    observer?.observe(element);
    return () => {
      live = false;
      fonts?.removeEventListener?.("loadingdone", check);
      observer?.disconnect();
    };
  }, [measure, expanded, fallbackLong, text]);

  const showButton = collapsible && (!measure || expanded || wasExpanded || overflowing);

  return (
    <>
      <div className={boxClassName ?? "mt-2 rounded-md bg-muted/40 p-3"}>
        {/* Shown whole or behind the announced preview: never in a box that scrolls its end out of sight. */}
        <pre
          ref={textRef}
          className={cn(
            // A pre is monospace by default. This is a person's message, so it takes the text face.
            "whitespace-pre-wrap wrap-anywhere font-sans text-sm leading-6 text-foreground",
            clamped && (previewLines === 6 ? "line-clamp-6" : "line-clamp-4"),
          )}
        >
          {text}
        </pre>
      </div>
      {showButton && (
        <button
          type="button"
          className={cn(
            "mt-1 inline-flex min-h-6 items-center text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground",
            // The email's own toggle is a 44px touch target on phones (the mobile operator rule).
            measure && "min-h-11 sm:min-h-6",
          )}
          aria-expanded={expanded}
          aria-label={expanded ? `Show less: ${subject}` : expandLabel ? `${expandLabel}: ${subject}` : undefined}
          onClick={(event) => {
            const collapsing = expanded;
            setExpanded((value) => !value);
            setWasExpanded(true);
            // After "Show less" the long text is gone from above: bring the collapsed email, label first,
            // back into view (clear of the sticky header) instead of leaving the reader in the draft.
            if (collapsing) {
              // A translation's own Show less returns to the translation, not to the email above it.
              const section = (event.currentTarget as HTMLElement).closest<HTMLElement>(
                "[data-approval-translation], [data-approval-original-request]",
              );
              requestAnimationFrame(() => {
                if (!section || typeof section.getBoundingClientRect !== "function") return;
                if (section.getBoundingClientRect().top < 80) section.scrollIntoView?.({ block: "start" });
              });
            }
          }}
        >
          {expanded ? "Show less" : (expandLabel ?? `Show full request (${text.length.toLocaleString()} characters)`)}
        </button>
      )}
    </>
  );
}

/**
 * A Board approval may answer a request from a person, or the agent may raise
 * it by itself. Without an attached source the board should know that, but one
 * quiet note is enough: it is the normal case for routine agent requests.
 */
export function approvalMissingSourceNote(
  type: string,
  payload?: Record<string, unknown> | null,
): string | null {
  if (type !== "request_board_approval" || approvalOriginalRequest(payload)) return null;
  return "No original request attached";
}

export type ApprovalHireFacts = {
  name: string | null;
  role: string | null;
  title: string | null;
  reportsToAgentId: string | null;
  adapterType: string | null;
  model: string | null;
  /** null when the request names no budget; 0 means no monthly limit is set. */
  budgetMonthlyCents: number | null;
  capabilities: string | null;
  skills: string[];
  /** The agent this request acts on: approval activates it and rejection terminates it. Null when approval creates one. */
  agentId: string | null;
};

export function approvalHireFacts(payload?: Record<string, unknown> | null): ApprovalHireFacts {
  const adapterConfig =
    payload?.adapterConfig && typeof payload.adapterConfig === "object" && !Array.isArray(payload.adapterConfig)
      ? (payload.adapterConfig as Record<string, unknown>)
      : null;
  return {
    name: firstNonEmptyString(payload?.name),
    role: firstNonEmptyString(payload?.role),
    title: firstNonEmptyString(payload?.title),
    reportsToAgentId: firstNonEmptyString(payload?.reportsTo),
    adapterType: firstNonEmptyString(payload?.adapterType),
    model: firstNonEmptyString(adapterConfig?.model),
    budgetMonthlyCents:
      typeof payload?.budgetMonthlyCents === "number" && Number.isFinite(payload.budgetMonthlyCents)
        ? payload.budgetMonthlyCents
        : null,
    capabilities: approvalReadableText(firstNonEmptyString(payload?.capabilities)),
    skills: uniqueStrings(payload?.desiredSkills),
    agentId: firstNonEmptyString(payload?.agentId),
  };
}

export type ApprovalStrategyPlan =
  | { kind: "text"; text: string }
  /** The request carries a plan, but not as text the summary can show. */
  | { kind: "unreadable" }
  | { kind: "missing" };

const STRATEGY_PLAN_FIELDS = ["plan", "description", "strategy", "text"] as const;

/** The plan a strategy approval asks the board to accept. */
export function approvalStrategyPlan(payload?: Record<string, unknown> | null): ApprovalStrategyPlan {
  const text = approvalReadableText(
    firstNonEmptyString(...STRATEGY_PLAN_FIELDS.map((field) => payload?.[field])),
  );
  if (text) return { kind: "text", text };
  const plan = payload?.plan;
  if (Array.isArray(plan) && plan.length > 0 && plan.every((step) => typeof step === "string")) {
    const joined = approvalReadableText(plan.join("\n"));
    if (joined) return { kind: "text", text: joined };
  }
  return plan !== null && plan !== undefined && typeof plan !== "string" ? { kind: "unreadable" } : { kind: "missing" };
}

/** The decision brief of a strategy approval, without the plan fields the summary shows as the plan. */
export function approvalStrategyBrief(payload?: Record<string, unknown> | null) {
  const rest: Record<string, unknown> = { ...(payload ?? {}) };
  for (const field of STRATEGY_PLAN_FIELDS) delete rest[field];
  return approvalDecisionBrief(rest);
}

/** How far a cut moves back to stay out of a character cluster; a longer cluster is cut as any long run is. */
const CLUSTER_REACH = 64;

/** Undefined until first asked for; null where the browser has no `Intl.Segmenter`. */
let graphemeSegmenter: Intl.Segmenter | null | undefined;

/**
 * The cut position at or before `end` that does not fall inside one character
 * as the reader sees it: a letter with its accent or tone mark, a flag, an
 * emoji joined from several, a keycap. A cut inside one changes the last thing
 * read before the ellipsis (a Thai syllable without its tone mark is another
 * syllable). Where the browser cannot tell, and for a cluster longer than
 * {@link CLUSTER_REACH}, only the two halves of a surrogate pair are kept
 * together.
 */
function clusterSafeEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  if (graphemeSegmenter === undefined) {
    try {
      graphemeSegmenter =
        typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
          ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
          : null;
    } catch {
      graphemeSegmenter = null;
    }
  }
  if (graphemeSegmenter) {
    // Read from the start of the text: whether two flag letters pair up depends on how many precede them.
    const cluster = graphemeSegmenter.segment(text.slice(0, end + CLUSTER_REACH)).containing(end);
    if (cluster && cluster.index > 0 && end - cluster.index <= CLUSTER_REACH) return cluster.index;
  }
  const last = text.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

/** The first lines of a long text, cut at a line or word boundary, with nothing added to mark the cut. */
function cutTextPreview(text: string, maxLines: number, maxLength: number): { preview: string; truncated: boolean } {
  const lines = text.split("\n");
  let preview = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  if (preview.length > maxLength) {
    const clipped = preview.slice(0, maxLength + 1);
    const boundary = Math.max(clipped.lastIndexOf(" "), clipped.lastIndexOf("\n"));
    // Never cut inside one character (an emoji, or a letter and its accent, for example).
    const end = clusterSafeEnd(preview, boundary > maxLength / 2 ? boundary : maxLength);
    preview = preview.slice(0, end);
    truncated = true;
  }
  return { preview: truncated ? preview.trimEnd() : preview, truncated };
}

/** The first lines of a long text, cut at a line or word boundary; a cut preview ends in an ellipsis. */
export function approvalTextPreview(
  text: string,
  maxLines = 6,
  maxLength = 480,
): { preview: string; truncated: boolean } {
  const { preview, truncated } = cutTextPreview(text, maxLines, maxLength);
  return { preview: truncated ? `${preview}…` : preview, truncated };
}

/** Characters of raw text an excerpt converts beyond four times its length: one label, one target, and their brackets. */
const EXCERPT_RAW_MARGIN = 2400;
/** How far back from that limit the cut looks for a space or a line break. */
const EXCERPT_RAW_BOUNDARY_REACH = 200;

/**
 * One line for a title or a subject: the readable text with its line breaks
 * folded into spaces, cut at a word boundary. Built on
 * {@link approvalReadableText}, so it drops markup and nothing else.
 */
export function approvalExcerpt(value: string | null, maxLength = 240): string | null {
  // A one-line excerpt reads only the start of the text, so only the start is converted. The
  // margin lets markup shrink the text fourfold and leaves room for one link of the longest
  // kind; a text of any length then costs the same.
  const rawLimit = Number.isFinite(maxLength) ? maxLength * 4 + EXCERPT_RAW_MARGIN : Number.POSITIVE_INFINITY;
  let raw = value;
  let rawWasCut = false;
  if (raw && raw.length > rawLimit) {
    let end = rawLimit;
    // Cut between words where one is near, so that no half of a token or of a rule line is left.
    const boundary = Math.max(raw.lastIndexOf(" ", end), raw.lastIndexOf("\n", end));
    if (boundary > end - EXCERPT_RAW_BOUNDARY_REACH) end = boundary;
    raw = raw.slice(0, clusterSafeEnd(raw, end));
    rawWasCut = true;
  }
  const plain = approvalReadableText(raw)?.replace(/\s+/g, " ");
  if (!plain) return null;
  // Text that was cut before conversion is never presented as the whole text.
  if (plain.length <= maxLength) return rawWasCut ? `${plain.trimEnd()}…` : plain;

  const clipped = plain.slice(0, maxLength + 1);
  const wordBoundary = clipped.lastIndexOf(" ");
  // Never cut inside one character (an emoji, or a letter and its accent, for example).
  const end = clusterSafeEnd(plain, wordBoundary > maxLength / 2 ? wordBoundary : maxLength);
  return `${plain.slice(0, end).trimEnd()}…`;
}

/**
 * What a request asks for, as one line for a collapsed queue row: the
 * recommendation of a Board approval, what a hire will do, or the first line
 * of a strategy's plan. Null when the request carries none of it. The line is
 * the readable text itself; the row cuts it to its width with CSS.
 */
export function approvalAskLine(
  type: string,
  payload?: Record<string, unknown> | null,
): { label: string; text: string } | null {
  if (type === "hire_agent") {
    const text = approvalExcerpt(firstNonEmptyString(payload?.capabilities));
    return text ? { label: "What it will do", text } : null;
  }
  if (type === "approve_ceo_strategy") {
    const plan = approvalStrategyPlan(payload);
    // With no plan field the summary shows the rationale as the plan; the row follows it.
    const planText =
      plan.kind === "text" ? plan.text : approvalReadableText(approvalStrategyBrief(payload).reasoning);
    const firstLine = planText?.split("\n").find((line) => line.trim()) ?? null;
    const text = approvalExcerpt(firstLine);
    return text ? { label: "Plan", text } : null;
  }
  const text = approvalExcerpt(approvalDecisionBrief(payload).recommendation);
  return text ? { label: "Recommendation", text } : null;
}

/** How much of a request's subject a card or queue row shows as its title. */
export const APPROVAL_TITLE_LENGTH = 120;

/** Longest summary that is checked against the recommendation, rationale and title for being a repeat. */
const SUMMARY_COMPARE_LIMIT = 20_000;

function comparableText(value: string | null | undefined): string | null {
  return approvalReadableText(value)?.replace(/\s+/g, " ").trim().toLocaleLowerCase() ?? null;
}

/**
 * The request's `summary`, when the surface does not already show the same
 * text: as the recommendation, as the rationale (which falls back to the
 * summary when the request gives no other), or as the title. Agents are told to
 * send a summary and may put the cost in it, so it must not go unshown. A
 * summary that is the title is still returned when the title is too long to be
 * shown whole.
 */
export function approvalSummaryText(payload?: Record<string, unknown> | null, type?: string): string | null {
  const summary = firstNonEmptyString(payload?.summary);
  if (!summary) return null;
  const brief = approvalDecisionBrief(payload);
  // A summary this long is not converted and compared with the other fields: it is shown, unless
  // it is the very text shown as the recommendation or the rationale (which falls back to the
  // summary), and would be on the page twice. That check takes the two texts whole, as they are.
  // Comparing a prefix instead would treat a summary that only starts like the recommendation as
  // already shown.
  if (summary.length > SUMMARY_COMPARE_LIMIT) {
    return summary === brief.recommendation || summary === brief.reasoning ? null : summary;
  }
  const comparable = comparableText(summary);
  if (!comparable) return null;
  if (comparable === comparableText(brief.recommendation) || comparable === comparableText(brief.reasoning)) {
    return null;
  }
  const isShownAsTitle =
    comparable === comparableText(approvalSubject(payload, type)) && comparable.length <= APPROVAL_TITLE_LENGTH;
  return isShownAsTitle ? null : summary;
}

export function approvalSubject(payload?: Record<string, unknown> | null, type?: string): string | null {
  // A hire is about a named agent; its `title` is the job title, not the subject.
  if (type === "hire_agent") return firstNonEmptyString(payload?.name, payload?.title);
  return firstNonEmptyString(
    payload?.title,
    payload?.name,
    payload?.summary,
    payload?.recommendedAction,
  );
}

export function isEmailReplyPayload(payload?: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  const hasBody = typeof payload.body === "string" && payload.body.trim().length > 0;
  const hasEnvelope =
    typeof payload.subject === "string" ||
    typeof payload.recipient === "string" ||
    typeof payload.channel === "string";
  return hasBody && hasEnvelope;
}

export type ApprovalEmailDraft = {
  /** The payload's `channel`: a free-text description of how the reply goes out, not an address. */
  via: string | null;
  /** The sender, only when the payload names one in `from`. */
  from: string | null;
  to: string | null;
  subject: string | null;
  body: string;
};

/** The outgoing draft of an email-reply approval. Never a source for the original request. */
export function approvalEmailDraft(payload?: Record<string, unknown> | null): ApprovalEmailDraft | null {
  if (!payload || !isEmailReplyPayload(payload)) return null;
  return {
    via: firstNonEmptyString(payload.channel),
    from: firstNonEmptyString(payload.from),
    to: firstNonEmptyString(payload.recipient),
    subject: firstNonEmptyString(payload.subject),
    body: String(payload.body),
  };
}

/** A compact surface shows an outgoing draft whole up to this many characters. */
export const APPROVAL_DRAFT_PREVIEW_LENGTH = 1500;

/**
 * What a compact surface shows of an outgoing draft before it is expanded: the
 * first characters, cut at a line or word boundary. Null when the whole body is
 * shown, so a caller can tell a cut draft from a whole one. Trailing blank
 * space hides no words and does not count towards the limit.
 *
 * The preview holds the draft's own characters and nothing else. An ellipsis
 * here would sit inside the email body, where it could be read as part of the
 * email; the caller states that the reply continues, outside the body.
 */
export function approvalDraftPreview(body: string): string | null {
  if (body.trimEnd().length <= APPROVAL_DRAFT_PREVIEW_LENGTH) return null;
  // The cut depends only on the first characters; a very long body is not scanned whole. The
  // characters past the limit are there so that the cut can see the character it would split.
  return cutTextPreview(
    body.slice(0, APPROVAL_DRAFT_PREVIEW_LENGTH + CLUSTER_REACH),
    Number.MAX_SAFE_INTEGER,
    APPROVAL_DRAFT_PREVIEW_LENGTH,
  ).preview;
}

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  const subject = approvalSubject(payload, type);
  if (subject) {
    return `${base}: ${subject}`;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  request_board_approval: ShieldCheck,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Skills</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Adapter</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(payload.adapterType)}
          </span>
        </div>
      )}
      <SkillList values={payload.desiredSkills} />
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  // The same field order the summary reads. A plan that is not text is shown as the request's data.
  const plan = firstNonEmptyString(...STRATEGY_PLAN_FIELDS.map((field) => payload[field]));
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {plan ? (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap wrap-anywhere font-mono text-xs">
          {plan}
        </div>
      ) : (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap wrap-anywhere">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Scope" value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label="Window" value={payload.windowKind} />
      <PayloadField label="Metric" value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Limit {budgetAmount !== null ? formatCents(budgetAmount) : "—"} · Observed {observedAmount !== null ? formatCents(observedAmount) : "—"}
        </div>
      ) : null}
      {!!payload.guidance && (
        <p className="text-muted-foreground">{String(payload.guidance)}</p>
      )}
    </div>
  );
}

export function BoardApprovalPayload({
  payload,
  hideTitle = false,
  resolveAgentName,
}: {
  payload: Record<string, unknown>;
  hideTitle?: boolean;
  resolveAgentName?: OriginalRequestSenderResolver;
}) {
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  return (
    <BoardApprovalPayloadContent payload={nextPayload} resolveAgentName={resolveAgentName} />
  );
}

/**
 * Decision-list items (pros, cons & risks) render inside a custom bullet row,
 * so a leading list marker ("- ", "* ", "• ", "1. ", "1) ") would show a
 * second marker beside the first. Strip exactly one leading marker.
 */
export function stripLeadingListMarker(value: string): string {
  return value.replace(/^(?:[-*•]|\d{1,3}[.)])[^\S\n]+/, "");
}

/** The time now, moved on every minute while `live`, so a deadline's wording and color stay current. */
function useMinuteClock(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

/**
 * The request's typed terms, when it has them: what approving costs and when the board must decide.
 * While the request is open a passed deadline is said in words and in the destructive color; once
 * it is decided the deadline is only its date.
 */
export function ApprovalTerms({
  payload,
  open = true,
  compact = false,
  className,
}: {
  payload: Record<string, unknown>;
  /** Whether the request still waits on the board (pending or sent back). */
  open?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const cost = approvalCost(payload);
  const decideBy = approvalDecideBy(payload);
  const now = useMinuteClock(open && decideBy !== null);
  if (!cost && !decideBy) return null;
  const state = decideBy && open ? decideByState(decideBy, now) : null;
  const deadlineText = decideBy ? (open ? decideByText(decideBy, now) : `Decide by ${formatDecideBy(decideBy)}`) : null;
  const deadlineClass =
    state === "overdue"
      ? "text-destructive font-medium"
      : state === "soon"
        ? "text-amber-700 dark:text-amber-300 font-medium"
        : "text-muted-foreground";
  if (compact) {
    return (
      <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs", className)} data-approval-terms="compact">
        {cost && <span className="text-foreground/80" data-approval-cost="">{formatApprovalCost(cost)}</span>}
        {decideBy && deadlineText && (
          <span className={deadlineClass} data-approval-decide-by={state ?? "decided"} title={formatDecideBy(decideBy)}>
            {deadlineText}
          </span>
        )}
      </span>
    );
  }
  return (
    <dl className={cn("grid gap-x-6 gap-y-2 sm:grid-cols-2", className)} data-approval-terms="">
      {cost && (
        <div className="space-y-0.5">
          <dt className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Cost</dt>
          <dd className="font-medium text-foreground" data-approval-cost="">{formatApprovalCost(cost)}</dd>
        </div>
      )}
      {decideBy && deadlineText && (
        <div className="space-y-0.5">
          <dt className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Decide by</dt>
          <dd className={deadlineClass} data-approval-decide-by={state ?? "decided"}>
            <time dateTime={decideBy.toISOString()} title={formatDecideBy(decideBy)}>{deadlineText}</time>
          </dd>
        </div>
      )}
    </dl>
  );
}

function BoardApprovalPayloadContent({
  payload,
  resolveAgentName,
}: {
  payload: Record<string, unknown>;
  resolveAgentName?: OriginalRequestSenderResolver;
}) {
  const brief = approvalDecisionBrief(payload);
  const title = firstNonEmptyString(payload.title);
  const summary = firstNonEmptyString(payload.summary);
  const reasoning = brief.reasoning === summary ? null : brief.reasoning;
  const proposedComment = firstNonEmptyString(payload.proposedComment);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {summary && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Summary</p>
          <MarkdownBody className="leading-6 text-foreground/90">{summary}</MarkdownBody>
        </div>
      )}
      {brief.recommendation && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-amber-700 dark:text-amber-300">
            Recommendation
          </p>
          <MarkdownBody className="mt-1 leading-6 text-foreground">{brief.recommendation}</MarkdownBody>
        </div>
      )}
      <OriginalRequestBlock payload={payload} resolveAgentName={resolveAgentName} />
      {reasoning && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Why</p>
          <MarkdownBody className="leading-6 text-foreground/90">{reasoning}</MarkdownBody>
        </div>
      )}
      {(brief.pros.length > 0 || brief.cons.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <DecisionList label="Pros" items={brief.pros} />
          <DecisionList label="Risks" items={brief.cons} />
        </div>
      )}
      {brief.nextAction && (
        <div className="rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">If approved</p>
          <MarkdownBody className="mt-1 leading-6 text-foreground">{brief.nextAction}</MarkdownBody>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Proposed comment
          </p>
          <pre className="rounded-lg border border-border/60 bg-muted/50 px-3.5 py-3 font-mono text-xs leading-5 text-muted-foreground whitespace-pre-wrap wrap-anywhere">
            {proposedComment}
          </pre>
        </div>
      )}
    </div>
  );
}

function EmailHeaderRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-16 shrink-0 pt-0.5 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 break-words leading-6 text-foreground/90">{value}</span>
    </div>
  );
}

function DecisionList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">{label}</p>
      <ul className="space-y-1 text-sm text-muted-foreground">
        {items.map((item, index) => {
          const text = stripLeadingListMarker(item);
          if (!text) return null;
          return (
            <li key={`${index}-${text}`} className="flex items-start gap-2">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
              <MarkdownBody className="leading-6">{text}</MarkdownBody>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function EmailReplyPayload({
  payload,
  resolveAgentName,
}: {
  payload: Record<string, unknown>;
  resolveAgentName?: OriginalRequestSenderResolver;
}) {
  const brief = approvalDecisionBrief(payload);
  // `channel` describes how the reply goes out ("email from info@"); only `from` names a sender.
  const channel = firstNonEmptyString(payload.channel);
  const sender = firstNonEmptyString(payload.from);
  const recipient = firstNonEmptyString(payload.recipient);
  const subject = firstNonEmptyString(payload.subject);
  const orderRef = firstNonEmptyString(payload.threadOrOrderRef);
  const gate = firstNonEmptyString(payload.gate);
  const body = firstNonEmptyString(payload.body) ?? "";
  const intent = firstNonEmptyString(payload.intent);
  const reasoning = brief.reasoning === intent ? null : brief.reasoning;
  const bodyTranslation = approvalTranslationFor(approvalDraftTranslation(payload), body);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      <div className="overflow-hidden rounded-lg border border-border/60 bg-background/60">
        <div className="space-y-1 border-b border-border/60 bg-muted/30 px-3.5 py-2.5">
          {channel && <EmailHeaderRow label="Via" value={channel} />}
          {sender && <EmailHeaderRow label="From" value={sender} />}
          {recipient && <EmailHeaderRow label="To" value={recipient} />}
          {subject && <EmailHeaderRow label="Subject" value={subject} />}
          {orderRef && <EmailHeaderRow label="Ref" value={orderRef} />}
          {gate && (
            <div className="flex gap-2">
              <span className="w-16 shrink-0 pt-0.5 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                Gate
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-(length:--text-micro) font-medium text-muted-foreground">
                {gate}
              </span>
            </div>
          )}
        </div>
      </div>

      {intent && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Intent</p>
          <p className="leading-6 text-foreground/90">{intent}</p>
        </div>
      )}
      {brief.recommendation && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-amber-700 dark:text-amber-300">
            Recommendation
          </p>
          <p className="mt-1 leading-6 text-foreground">{brief.recommendation}</p>
        </div>
      )}
      {reasoning && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Why</p>
          <p className="leading-6 text-foreground/90">{reasoning}</p>
        </div>
      )}
      {(brief.pros.length > 0 || brief.cons.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <DecisionList label="Pros" items={brief.pros} />
          <DecisionList label="Risks" items={brief.cons} />
        </div>
      )}
      {/* The email being answered, right above the reply to it. */}
      <OriginalRequestBlock payload={payload} resolveAgentName={resolveAgentName} />
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Draft reply
          </p>
          <ApprovalDraftLanguageChip language={bodyTranslation?.language ?? null} />
        </div>
        {/* The text that is sent sits in a solid frame; its translation below in a dashed one. */}
        <pre
          className="whitespace-pre-wrap wrap-anywhere rounded-md border border-border bg-muted/40 p-3 font-sans text-sm leading-6 text-foreground"
        >
          {body}
        </pre>
        <ApprovalDraftTranslation translation={bodyTranslation} draft={body} />
      </div>
    </div>
  );
}

export function ApprovalPayloadRenderer({
  type,
  payload,
  hidePrimaryTitle = false,
  resolveAgentName,
}: {
  type: string;
  payload: Record<string, unknown>;
  hidePrimaryTitle?: boolean;
  /** Names the agent that wrote the original request's comment. */
  resolveAgentName?: OriginalRequestSenderResolver;
}) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "request_board_approval") {
    if (isEmailReplyPayload(payload)) return <EmailReplyPayload payload={payload} resolveAgentName={resolveAgentName} />;
    return (
      <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} resolveAgentName={resolveAgentName} />
    );
  }
  return <CeoStrategyPayload payload={payload} />;
}
