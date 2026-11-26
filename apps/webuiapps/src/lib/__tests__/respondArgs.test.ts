import { describe, expect, it } from 'vitest';
import { readRespondArgs } from '../respondArgs';

describe('readRespondArgs', () => {
  it('reads the documented object shape', () => {
    expect(
      readRespondArgs({
        character_expression: { content: 'Hello', emotion: 'Happy' },
        user_interaction: { suggested_replies: ['a', 'b', 3] },
      }),
    ).toEqual({ content: 'Hello', emotion: 'happy', suggestedReplies: ['a', 'b'] });
  });

  it('reads the "(content: ...)(emotion: ...)" string some free models send', () => {
    // Seen on anker: the whole expression arrives as one string.
    const args = readRespondArgs({
      character_expression:
        '(content: "(fans her cards) Relax, darling.\\nJust me.")\n(emotion: happy)',
      user_interaction: '(suggested_replies: ["Who are you?", "A spaceship?"])',
    });
    expect(args).toEqual({
      content: '(fans her cards) Relax, darling.\nJust me.',
      emotion: 'happy',
      suggestedReplies: ['Who are you?', 'A spaceship?'],
    });
  });

  it('reads a JSON string expression and JSON string replies', () => {
    const args = readRespondArgs({
      character_expression: '{"content":"Hi","emotion":"shy"}',
      user_interaction: '{"suggested_replies":["x"]}',
    });
    expect(args).toEqual({ content: 'Hi', emotion: 'shy', suggestedReplies: ['x'] });
    expect(readRespondArgs({ suggested_replies: '["y"]', content: 'top' })).toEqual({
      content: 'top',
      emotion: undefined,
      suggestedReplies: ['y'],
    });
  });

  it('treats an unstructured string as the reply, dropping a trailing emotion tag', () => {
    expect(readRespondArgs({ character_expression: 'Just talking.\nemotion: angry' })).toEqual({
      content: 'Just talking.',
      emotion: 'angry',
      suggestedReplies: [],
    });
  });

  it('falls back to the plain assistant text when the tool call carries none', () => {
    expect(
      readRespondArgs({ character_expression: {} }, '(grins) Pick a card.\n\nemotion: happy'),
    ).toEqual({ content: '(grins) Pick a card.', emotion: 'happy', suggestedReplies: [] });
    expect(readRespondArgs({ character_expression: { emotion: 'shy' } }, 'Hm.').emotion).toBe(
      'shy',
    );
  });

  it('returns empty content when there is nothing to show', () => {
    expect(readRespondArgs({ character_expression: 42 }, '  ')).toEqual({
      content: '',
      emotion: undefined,
      suggestedReplies: [],
    });
    expect(readRespondArgs({ user_interaction: 'no list here' }).suggestedReplies).toEqual([]);
  });

  it('keeps the raw text when a quoted content has a bad escape', () => {
    expect(readRespondArgs({ character_expression: 'content: "a\\qb"' }).content).toBe('a\\qb');
  });
});
