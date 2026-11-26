/**
 * Tolerant reading of respond_to_user arguments.
 *
 * The tool expects `{ character_expression: { content, emotion }, user_interaction:
 * { suggested_replies } }`, but some (free) models send the inner objects as
 * strings, e.g. `(content: "Hello")\n(emotion: happy)` or a JSON string, or put
 * the reply text in the plain assistant content instead. This turns all of those
 * into one shape so the reply is never shown as an empty bubble.
 */

export interface RespondArgs {
  content: string;
  emotion?: string;
  suggestedReplies: string[];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Value of `key: "..."` (double-quoted, escapes allowed) inside free text. */
function quotedField(text: string, key: string): string | undefined {
  const m = new RegExp(`${key}\\s*[:=]\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's').exec(text);
  if (!m) return undefined;
  const parsed = tryJson(`"${m[1]}"`);
  return typeof parsed === 'string' ? parsed : m[1];
}

const EMOTION_RE = /emotion\s*[:=]\s*"?([a-z_]+)"?/i;
/** A trailing "emotion: happy" line that some models append to plain text. */
const TRAILING_EMOTION_RE = /\s*\(?\s*emotion\s*[:=]\s*"?[a-z_]+"?\s*\)?\s*$/i;

function readExpression(raw: unknown): { content?: string; emotion?: string } {
  if (isObj(raw)) {
    return {
      content: typeof raw.content === 'string' ? raw.content : undefined,
      emotion: typeof raw.emotion === 'string' ? raw.emotion : undefined,
    };
  }
  if (typeof raw !== 'string') return {};
  const text = raw.trim();
  const json = tryJson(text);
  if (isObj(json)) return readExpression(json);
  const content = quotedField(text, 'content');
  const emotion = EMOTION_RE.exec(text)?.[1];
  if (content !== undefined) return { content, emotion };
  // Plain text, maybe with an emotion tag at the end.
  return { content: text.replace(TRAILING_EMOTION_RE, ''), emotion };
}

function readReplies(raw: unknown): string[] {
  let value: unknown = raw;
  if (typeof value === 'string') {
    const json = tryJson(value);
    if (json !== undefined) {
      value = json;
    } else {
      const list = /\[[\s\S]*\]/.exec(value)?.[0];
      value = list ? tryJson(list) : undefined;
    }
  }
  if (isObj(value)) value = value.suggested_replies;
  return Array.isArray(value) ? value.filter((r): r is string => typeof r === 'string') : [];
}

/**
 * Normalise respond_to_user params. `plainText` is the assistant message's own
 * content, used when the tool call carries no text.
 */
export function readRespondArgs(params: Obj, plainText?: string | null): RespondArgs {
  const expr = readExpression(params.character_expression ?? params);
  let content = (expr.content ?? '').trim();
  let emotion = expr.emotion;
  if (!content && plainText?.trim()) {
    const fallback = readExpression(plainText);
    content = (fallback.content ?? '').trim();
    emotion = emotion ?? fallback.emotion;
  }
  const suggestedReplies = readReplies(params.user_interaction ?? params.suggested_replies);
  return { content, emotion: emotion?.toLowerCase(), suggestedReplies };
}
