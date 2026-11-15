import { describe, it, expect, vi } from 'vitest';
import {
  createSpeechInput,
  getRecognitionConstructor,
  isSecureForSpeechInput,
  isSpeechInputSupported,
  mapRecognitionError,
  recognitionLang,
  transcriptOf,
  type RecognitionLike,
  type RecognitionResultEvent,
} from '../speechInput';

/** A controllable stand-in for the browser's SpeechRecognition. */
class FakeRecognition implements RecognitionLike {
  static instances: FakeRecognition[] = [];
  static throwOnStart = false;
  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 5;
  onresult: RecognitionLike['onresult'] = null;
  onerror: RecognitionLike['onerror'] = null;
  onend: RecognitionLike['onend'] = null;
  started = false;
  stopped = false;
  aborted = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    if (FakeRecognition.throwOnStart) throw new Error('InvalidStateError');
    this.started = true;
  }
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  abort() {
    this.aborted = true;
    this.onerror?.({ error: 'aborted' });
    this.onend?.();
  }
  /** Simulate recognised speech; each phrase is one result. */
  hear(phrases: string[], final = false) {
    const results = phrases.map((transcript, i) =>
      Object.assign([{ transcript }], { isFinal: final || i < phrases.length - 1 }),
    );
    this.onresult?.({ resultIndex: 0, results });
  }
  fail(error: string) {
    this.onerror?.({ error });
    this.onend?.();
  }
}

const reset = () => {
  FakeRecognition.instances = [];
  FakeRecognition.throwOnStart = false;
};

const setup = (win: Record<string, unknown> = {}, lang?: string) => {
  reset();
  const handlers = {
    onInterim: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
  };
  const input = createSpeechInput(handlers, {
    lang,
    win: { webkitSpeechRecognition: FakeRecognition, isSecureContext: true, ...win },
  });
  const rec = () => FakeRecognition.instances[0];
  return { handlers, input, rec };
};

describe('speechInput: support checks', () => {
  it('prefers the standard constructor, falls back to the webkit one', () => {
    class Std extends FakeRecognition {}
    expect(getRecognitionConstructor({ SpeechRecognition: Std })).toBe(Std);
    expect(getRecognitionConstructor({ webkitSpeechRecognition: FakeRecognition })).toBe(
      FakeRecognition,
    );
    expect(getRecognitionConstructor({})).toBeNull();
    expect(isSpeechInputSupported({ webkitSpeechRecognition: FakeRecognition })).toBe(true);
    expect(isSpeechInputSupported({})).toBe(false);
  });

  it('uses the real window by default', () => {
    // jsdom has no speech recognition
    expect(isSpeechInputSupported()).toBe(false);
    expect(typeof isSecureForSpeechInput()).toBe('boolean');
  });

  it('treats only an explicitly insecure page as insecure', () => {
    expect(isSecureForSpeechInput({ isSecureContext: false })).toBe(false);
    expect(isSecureForSpeechInput({ isSecureContext: true })).toBe(true);
    expect(isSecureForSpeechInput({})).toBe(true);
  });

  it('maps app languages to recognition languages', () => {
    expect(recognitionLang('en')).toBe('en-US');
    expect(recognitionLang('zh')).toBe('zh-CN');
    expect(recognitionLang('ZH-TW')).toBe('zh-CN');
    expect(recognitionLang('fr')).toBe('en-US');
  });

  it('maps recognition error codes to reasons', () => {
    expect(mapRecognitionError('not-allowed')).toBe('denied');
    expect(mapRecognitionError('service-not-allowed')).toBe('denied');
    expect(mapRecognitionError('no-speech')).toBe('no-speech');
    expect(mapRecognitionError('audio-capture')).toBe('no-mic');
    expect(mapRecognitionError('network')).toBe('network');
    expect(mapRecognitionError('language-not-supported')).toBe('other');
  });

  it('joins all results into one string, skipping empty ones', () => {
    const results = [
      Object.assign([{ transcript: ' open the ' }], { isFinal: true }),
      Object.assign([{ transcript: '' }], { isFinal: true }),
      Object.assign([] as Array<{ transcript: string }>, { isFinal: false }),
      Object.assign([{ transcript: 'music player ' }], { isFinal: false }),
    ];
    const event: RecognitionResultEvent = { resultIndex: 0, results };
    expect(transcriptOf(event)).toBe('open the music player');
  });
});

describe('speechInput: listening', () => {
  it('configures one utterance with interim results', () => {
    const { input, rec } = setup({}, 'zh');
    input.start();
    expect(rec().started).toBe(true);
    expect(rec().lang).toBe('zh-CN');
    expect(rec().continuous).toBe(false);
    expect(rec().interimResults).toBe(true);
    expect(rec().maxAlternatives).toBe(1);
    expect(input.isListening()).toBe(true);
  });

  it('defaults to English', () => {
    const { input, rec } = setup();
    input.start();
    expect(rec().lang).toBe('en-US');
  });

  it('shows text while speaking and sends it once when the speaker pauses', () => {
    const { input, rec, handlers } = setup();
    input.start();
    rec().hear(['hello']);
    rec().hear(['hello there', 'how are you']);
    expect(handlers.onInterim).toHaveBeenLastCalledWith('hello there how are you');
    expect(handlers.onFinal).not.toHaveBeenCalled();
    rec().onend?.();
    expect(handlers.onFinal).toHaveBeenCalledTimes(1);
    expect(handlers.onFinal).toHaveBeenCalledWith('hello there how are you');
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    expect(input.isListening()).toBe(false);
  });

  it('sends the last interim text when Safari ends without a final result', () => {
    const { input, rec, handlers } = setup();
    input.start();
    rec().hear(['play some jazz']);
    input.stop();
    expect(rec().stopped).toBe(true);
    expect(handlers.onFinal).toHaveBeenCalledWith('play some jazz');
  });

  it('sends nothing when nothing was heard', () => {
    const { input, rec, handlers } = setup();
    input.start();
    rec().hear(['   ']);
    rec().onend?.();
    expect(handlers.onFinal).not.toHaveBeenCalled();
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
  });

  it('abort() discards what was heard, without an error', () => {
    const { input, rec, handlers } = setup();
    input.start();
    rec().hear(['never mind']);
    input.abort();
    expect(rec().aborted).toBe(true);
    expect(handlers.onFinal).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
  });

  it('stop() and abort() do nothing when not listening', () => {
    const { input, handlers } = setup();
    input.stop();
    input.abort();
    expect(handlers.onEnd).not.toHaveBeenCalled();
  });

  it('ignores start() while already listening', () => {
    const { input } = setup();
    input.start();
    input.start();
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('can listen again after finishing, with a fresh transcript', () => {
    const { input, handlers } = setup();
    input.start();
    FakeRecognition.instances[0].hear(['first']);
    FakeRecognition.instances[0].onend?.();
    input.start();
    FakeRecognition.instances[1].hear(['second']);
    FakeRecognition.instances[1].onend?.();
    expect(handlers.onFinal.mock.calls).toEqual([['first'], ['second']]);
  });

  it('reports an error and sends nothing when recognition fails', () => {
    const { input, rec, handlers } = setup();
    input.start();
    rec().hear(['half a sen']);
    rec().fail('not-allowed');
    expect(handlers.onError).toHaveBeenCalledWith('denied');
    expect(handlers.onFinal).not.toHaveBeenCalled();
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
  });

  it('reports "no-speech" when nothing was said', () => {
    const { input, rec, handlers } = setup();
    input.start();
    rec().fail('no-speech');
    expect(handlers.onError).toHaveBeenCalledWith('no-speech');
  });
});

describe('speechInput: cannot start', () => {
  it('explains a missing recogniser, and still ends', () => {
    reset();
    const onError = vi.fn();
    const onEnd = vi.fn();
    const input = createSpeechInput({ onError, onEnd }, { win: {} });
    input.start();
    expect(onError).toHaveBeenCalledWith('unsupported');
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(input.isListening()).toBe(false);
  });

  it('explains that iPhone Safari needs https', () => {
    const { input, handlers } = setup({ isSecureContext: false });
    input.start();
    expect(handlers.onError).toHaveBeenCalledWith('insecure');
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it('recovers when the browser refuses to start', () => {
    const { input, handlers } = setup();
    FakeRecognition.throwOnStart = true;
    input.start();
    expect(handlers.onError).toHaveBeenCalledWith('other');
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    expect(input.isListening()).toBe(false);
    FakeRecognition.throwOnStart = false;
    input.start();
    expect(input.isListening()).toBe(true);
  });

  it('works without any handlers', () => {
    reset();
    const input = createSpeechInput({}, { win: { webkitSpeechRecognition: FakeRecognition } });
    input.start();
    FakeRecognition.instances[0].hear(['hi']);
    FakeRecognition.instances[0].fail('network');
    input.start();
    FakeRecognition.instances[1].hear(['hi']);
    FakeRecognition.instances[1].onend?.();
    expect(input.isListening()).toBe(false);
    createSpeechInput({}, { win: {} }).start();
  });
});
