export type VrmEmotion = 'neutral' | 'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised';

export type AssistantSpeech = {
  displayText: string;
  ttsText: string;
  emotion: VrmEmotion;
  rawEmotionTags: string[];
  sentences: string[];
};

const ABBREVIATIONS = new Set([
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'sr.',
  'jr.',
  'st.',
  'vs.',
  'etc.',
  'e.g.',
  'i.e.',
]);

const EMOTION_ALIASES: Record<string, VrmEmotion> = {
  neutral: 'neutral',
  caring: 'relaxed',
  calm: 'relaxed',
  soft: 'relaxed',
  relaxed: 'relaxed',
  happy: 'happy',
  joy: 'happy',
  excited: 'happy',
  flustered: 'happy',
  tsundere: 'angry',
  annoyed: 'angry',
  angry: 'angry',
  pouting: 'angry',
  mad: 'angry',
  sad: 'sad',
  sadness: 'sad',
  lonely: 'sad',
  surprised: 'surprised',
  surprise: 'surprised',
  shocked: 'surprised',
};

export function prepareAssistantSpeech(text: string): AssistantSpeech {
  const rawEmotionTags = extractEmotionTags(text);
  const emotion = mapEmotionTag(rawEmotionTags[0]);
  const displayText = normalizeWhitespace(stripSpeechMarkup(text));
  const ttsText = splitSentences(displayText).join(' ');

  return {
    displayText,
    ttsText,
    emotion,
    rawEmotionTags,
    sentences: splitSentences(displayText),
  };
}

export function extractEmotionTags(text: string): string[] {
  const tags: string[] = [];
  const tagPattern = /\[([a-zA-Z][a-zA-Z0-9_-]*)\]/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(text)) !== null) {
    tags.push(match[1].toLowerCase());
  }

  return tags;
}

export function mapEmotionTag(tag: string | undefined): VrmEmotion {
  if (!tag) return 'neutral';
  return EMOTION_ALIASES[tag.toLowerCase()] || 'neutral';
}

export function stripSpeechMarkup(text: string): string {
  return text
    .replace(/\[([a-zA-Z][a-zA-Z0-9_-]*)\[/g, '[$1]')
    .replace(/\[[a-zA-Z][a-zA-Z0-9_-]*\]/g, ' ')
    .replace(/\*{1,}((?!\*).)*?\*{1,}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/["“”]/g, '');
}

export function splitSentences(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  const sentences: string[] = [];
  let start = 0;
  let index = 0;

  while (index < normalized.length) {
    const char = normalized[index];
    const isEllipsis = normalized.slice(index, index + 3) === '...';
    const isBoundary = isSentenceBoundary(char) || isEllipsis;

    if (!isBoundary) {
      index++;
      continue;
    }

    const boundaryEnd = isEllipsis ? index + 3 : index + 1;
    const candidate = normalized.slice(start, boundaryEnd).trim();

    if (candidate && !endsWithAbbreviation(candidate)) {
      let segmentEnd = boundaryEnd;
      while (segmentEnd < normalized.length && /["')\]]/.test(normalized[segmentEnd])) {
        segmentEnd++;
      }

      sentences.push(normalized.slice(start, segmentEnd).trim());
      while (segmentEnd < normalized.length && /\s/.test(normalized[segmentEnd])) {
        segmentEnd++;
      }
      start = segmentEnd;
      index = segmentEnd;
      continue;
    }

    index = boundaryEnd;
  }

  const rest = normalized.slice(start).trim();
  if (rest) {
    sentences.push(rest);
  }

  return sentences;
}

function isSentenceBoundary(char: string): boolean {
  return char === '.' || char === '!' || char === '?' || char === '\u3002' || char === '\uFF01' || char === '\uFF1F';
}

function endsWithAbbreviation(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/);
  const lastWord = words[words.length - 1];
  return ABBREVIATIONS.has(lastWord);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
