/**
 * Voice input with the browser's built-in speech recognition (Web Speech API).
 * Safari (Mac and iPhone) and Chrome provide it as `webkitSpeechRecognition`;
 * Firefox has none. Free, no server or key needed.
 *
 * One listen = one utterance: start() listens until the speaker pauses (or
 * stop() is called), then reports the whole text once via onFinal.
 */

/** Why listening failed, in terms the UI can explain. */
export type SpeechInputError =
  | 'denied' // microphone or speech recognition permission refused
  | 'insecure' // page not served over https (iPhone Safari requires it)
  | 'no-speech' // nothing heard
  | 'no-mic' // no microphone available
  | 'network' // recognition service unreachable
  | 'unsupported' // browser has no speech recognition
  | 'other';

export interface SpeechInputHandlers {
  /** Text so far while the user is still speaking */
  onInterim?: (text: string) => void;
  /** The full utterance, once, when listening ends with something heard */
  onFinal?: (text: string) => void;
  onError?: (error: SpeechInputError) => void;
  /** Listening stopped, or could not start (always called, after onFinal / onError) */
  onEnd?: () => void;
}

export interface SpeechInput {
  start(): void;
  /** Stop listening and report what was heard so far */
  stop(): void;
  /** Stop listening and discard what was heard */
  abort(): void;
  isListening(): boolean;
}

/** The parts of SpeechRecognition this module uses. */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

export type RecognitionConstructor = new () => RecognitionLike;

interface SpeechWindow {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
  isSecureContext?: boolean;
}

export function getRecognitionConstructor(
  win: SpeechWindow = window as unknown as SpeechWindow,
): RecognitionConstructor | null {
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

export function isSpeechInputSupported(win?: SpeechWindow): boolean {
  return getRecognitionConstructor(win) !== null;
}

/** Microphone access needs https (or localhost); otherwise browsers refuse it. */
export function isSecureForSpeechInput(
  win: SpeechWindow = window as unknown as SpeechWindow,
): boolean {
  return win.isSecureContext !== false;
}

/** App language → recognition language tag. */
export function recognitionLang(lang: string): string {
  return lang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function mapRecognitionError(code: string): SpeechInputError {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'denied';
    case 'no-speech':
      return 'no-speech';
    case 'audio-capture':
      return 'no-mic';
    case 'network':
      return 'network';
    default:
      return 'other';
  }
}

/** Join all results of the session into one tidy string. */
export function transcriptOf(event: RecognitionResultEvent): string {
  const parts: string[] = [];
  for (let i = 0; i < event.results.length; i++) {
    const best = event.results[i][0];
    if (best?.transcript) parts.push(best.transcript.trim());
  }
  return parts.filter(Boolean).join(' ');
}

export function createSpeechInput(
  handlers: SpeechInputHandlers,
  options: { lang?: string; win?: SpeechWindow } = {},
): SpeechInput {
  const win = options.win ?? (window as unknown as SpeechWindow);
  let recognition: RecognitionLike | null = null;
  let heard = '';
  let discard = false;
  let failed = false;

  const finish = () => {
    const text = heard.trim();
    const report = !discard && !failed && text.length > 0;
    recognition = null;
    heard = '';
    if (report) handlers.onFinal?.(text);
    handlers.onEnd?.();
  };

  /** Listening could not start: report why, then end. */
  const fail = (error: SpeechInputError) => {
    handlers.onError?.(error);
    handlers.onEnd?.();
  };

  return {
    start() {
      if (recognition) return;
      const Recognition = getRecognitionConstructor(win);
      if (!Recognition) return fail('unsupported');
      if (!isSecureForSpeechInput(win)) return fail('insecure');
      const rec = new Recognition();
      rec.lang = recognitionLang(options.lang ?? 'en');
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      heard = '';
      discard = false;
      failed = false;
      rec.onresult = (event) => {
        heard = transcriptOf(event);
        handlers.onInterim?.(heard);
      };
      rec.onerror = (event) => {
        // 'aborted' is our own abort(); 'no-speech' just means nothing to send
        if (event.error === 'aborted') return;
        failed = true;
        handlers.onError?.(mapRecognitionError(event.error));
      };
      rec.onend = finish;
      recognition = rec;
      try {
        rec.start();
      } catch {
        recognition = null;
        fail('other');
      }
    },
    stop() {
      recognition?.stop();
    },
    abort() {
      if (!recognition) return;
      discard = true;
      recognition.abort();
    },
    isListening() {
      return recognition !== null;
    },
  };
}
