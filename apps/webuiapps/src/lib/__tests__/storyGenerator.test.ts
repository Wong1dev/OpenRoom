import { describe, expect, it, vi } from 'vitest';
import type { CharacterConfig } from '../characterManager';
import type { LLMConfig } from '../llmModels';
import type { ModConfig, ModState } from '../modManager';
import {
  buildReviseMessages,
  buildStoryMessages,
  draftToConfig,
  extractJson,
  generateStory,
  reviseNextStage,
  type ChatFn,
  type StoryRequest,
} from '../storyGenerator';

const llm = { provider: 'openai', apiKey: '', baseUrl: 'http://x', model: 'm' } as LLMConfig;

const kestrel: CharacterConfig = {
  id: 'kestrel',
  character_name: 'Kestrel Vane',
  character_gender_desc: 'Female',
  character_desc: 'A half-elf card sharp.',
  character_emotion_list: ['default'],
};
const aoi: CharacterConfig = {
  ...kestrel,
  id: 'aoi',
  character_name: 'Aoi',
  character_desc: 'A bounty hunter.',
};

const goodDraft = {
  title: 'The Lantern Card',
  setting: 'A riverside tavern in the Riverlands.',
  display_desc: 'A card that should not exist. Genre: Fantasy',
  prologue: '(flips a card) Evening, stranger.',
  opening_replies: ['Who are you?', 'Where am I?', 'Show me a trick', 'extra'],
  lead_id: 'kes',
  cast: [
    { id: 'kes', name: 'Kestrel', character_id: 'kestrel', role: 'card sharp', persona: 'winning' },
    {
      id: 'Pell the Barmaid',
      name: 'Pell',
      gender: 'Female',
      role: 'barmaid',
      persona: 'Dry wit.',
      secret: 'She saw the collector palm the card.',
      portrait_prompt: 'freckled barmaid',
    },
    { id: 'pell_the_barmaid', name: 'Pell Twin', role: 'twin', persona: 'Same id.' },
  ],
  stages: [
    { name: 'Booth', description: 'Meet.', targets: ['Do a trick', 'Find the card'] },
    { name: 'Taproom', description: 'Investigate.', targets: ['Find Varga'] },
    { name: 'Cellar', description: 'Play.', targets: ['Win the ledger'] },
  ],
};

const req: StoryRequest = { characters: [kestrel], premise: 'cards', stageCount: 3 };

const answer = (content: string | null) => ({ content, toolCalls: [] });

describe('extractJson', () => {
  it('reads plain, fenced and wrapped JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Sure! {"a":3} Enjoy')).toEqual({ a: 3 });
  });
  it('rejects empty or missing JSON', () => {
    expect(() => extractJson(null)).toThrow('empty');
    expect(() => extractJson('no json here')).toThrow('no JSON');
  });
});

describe('buildStoryMessages', () => {
  it('includes the characters, wishes and stage count', () => {
    const [sys, user] = buildStoryMessages({
      characters: [kestrel, aoi],
      premise: 'heist',
      stageCount: 4,
    });
    expect(sys.content).toContain('Exactly 4 stages');
    expect(user.content).toContain('character_id: "kestrel"');
    expect(user.content).toContain('character_id: "aoi"');
    expect(user.content).toContain('heist');
  });

  it('asks for a surprise without wishes and describes a sequel', () => {
    const prev: ModConfig = {
      id: 'old',
      mod_name: 'Old',
      mod_name_en: 'Old Tale',
      mod_description: 'old setting',
      stage_count: 1,
      stages: {
        0: { stage_index: 0, stage_name: 'End', stage_description: 'done', stage_targets: {} },
      },
      cast: [
        { id: 'pell', name: 'Pell', gender: 'F', role: 'barmaid', persona: '' },
        {
          id: 'kes',
          name: 'Kestrel',
          gender: 'F',
          role: 'lead',
          persona: '',
          character_id: 'kestrel',
        },
      ],
    };
    const state: ModState = {
      current_stage_index: 1,
      total_stage_count: 1,
      is_finished: true,
      completed_targets: [],
      plot_log: ['Burned the ledger'],
      cast_state: { pell: { attitude: 'fond', knows: ['the truth'], notes: [] } },
    };
    const [, user] = buildStoryMessages({
      characters: [kestrel],
      stageCount: 3,
      sequelOf: { config: prev, state },
    });
    expect(user.content).toContain('surprise them');
    expect(user.content).toContain('Old Tale');
    expect(user.content).toContain('Burned the ledger');
    expect(user.content).toContain('Feels: fond. Knows: the truth');
    expect(user.content).toContain('(character_id "kestrel")');
  });

  it('describes a sequel without cast or choices', () => {
    const prev: ModConfig = {
      id: 'old',
      mod_name: 'Old',
      mod_name_en: '',
      mod_description: 'x',
      stage_count: 0,
      stages: {},
    };
    const state: ModState = {
      current_stage_index: 0,
      total_stage_count: 0,
      is_finished: false,
      completed_targets: [],
    };
    const [, user] = buildStoryMessages({
      characters: [kestrel],
      stageCount: 3,
      sequelOf: { config: prev, state },
    });
    expect(user.content).toContain('Title: Old');
    expect(user.content).not.toContain('Cast at the end');
  });
});

describe('draftToConfig', () => {
  it('converts a valid draft', () => {
    const result = draftToConfig(goodDraft, req, 'story_1');
    if (!('config' in result)) throw new Error(result.errors.join('; '));
    const c = result.config;
    expect(c.id).toBe('story_1');
    expect(c.mod_name_en).toBe('The Lantern Card');
    expect(c.mod_description).toContain('A riverside tavern');
    expect(c.mod_description).toContain('generate_image');
    expect(c.stage_count).toBe(3);
    expect(c.stages[0].stage_targets).toEqual({ 1: 'Do a trick', 2: 'Find the card' });
    expect(c.stages[2].stage_targets).toEqual({ 4: 'Win the ledger' });
    expect(c.opening_rec_replies).toHaveLength(3);
    const ids = c.cast!.map((m) => m.id);
    expect(ids).toEqual(['kes', 'pell_the_barmaid', 'pell_the_barmaid_2']);
    expect(c.cast![0]).toMatchObject({
      name: 'Kestrel Vane',
      character_id: 'kestrel',
      gender: 'Female',
    });
    expect(c.cast![0].portrait_prompt).toBeUndefined();
    expect(c.cast![1]).toMatchObject({
      portrait_prompt: 'freckled barmaid',
      secret: expect.any(String),
    });
    expect(c.cast![2].gender).toBe('unspecified');
    expect(c.lead_id).toBe('kes');
  });

  it('falls back for lead, names, replies and odd ids', () => {
    const draft = {
      ...goodDraft,
      opening_replies: undefined,
      display_desc: '',
      lead_id: 'zed',
      cast: [
        { id: '9lives', name: 'Cat', role: '', persona: 'Purrs.' },
        { id: 'dog', name: 'Dog', persona: 'Barks.' },
      ],
      stages: goodDraft.stages.map((s, i) => (i === 0 ? { ...s, name: '' } : s)),
    };
    const result = draftToConfig(draft, { ...req, characters: [] }, 'x');
    if (!('config' in result)) throw new Error(result.errors.join('; '));
    expect(result.config.cast![0].id).toBe('c_9lives');
    expect(result.config.cast![0].role).toBe('a character in this story');
    expect(result.config.stages[0].stage_name).toBe('Stage 1');
    expect(result.config.opening_rec_replies).toBeUndefined();
    expect(result.config.display_desc).toBeUndefined();
    expect(result.config.lead_id).toBe('c_9lives');
    // A lead given by the model's own id is mapped to the final id
    const byId = draftToConfig({ ...draft, lead_id: 'dog' }, { ...req, characters: [] }, 'x');
    expect('config' in byId && byId.config.lead_id).toBe('dog');
  });

  it('lists every problem', () => {
    const result = draftToConfig(
      {
        display_desc: 'Twist: She saw the collector palm the card.',
        cast: [
          { name: 'Pell', persona: '', secret: 'She saw the collector palm the card.' },
          { name: 'Ghost', character_id: 'nobody', persona: 'x' },
          { id: 'noname' },
          'junk',
        ],
        stages: [{ name: 'Only', description: '', targets: [] }, null],
      },
      req,
      'x',
    );
    if (!('errors' in result)) throw new Error('expected errors');
    const e = result.errors.join('\n');
    expect(e).toContain('"title" is missing');
    expect(e).toContain('"setting" is missing');
    expect(e).toContain('"prologue" is missing');
    expect(e).toContain('has no "persona"');
    expect(e).toContain('unknown character_id "nobody"');
    expect(e).toContain('a cast member has no "name"');
    expect(e).toContain('"Kestrel Vane" (character_id "kestrel") must be in the cast');
    expect(e).toContain("reveals Pell's secret");
    expect(e).toContain('exactly 3 stages (got 2)');
    expect(e).toContain('stage 1 has no "description"');
    expect(e).toContain('stage 1 has no "targets"');
  });

  it('rejects an empty or oversized cast and non-objects', () => {
    const empty = draftToConfig(null, req, 'x');
    expect('errors' in empty && empty.errors.join()).toContain('"cast" must list');
    const big = draftToConfig(
      {
        ...goodDraft,
        cast: Array.from({ length: 9 }, (_, i) => ({ name: `N${i}`, persona: 'p' })),
      },
      { ...req, characters: [] },
      'x',
    );
    expect('errors' in big && big.errors.join()).toContain('more than 8');
  });
});

describe('generateStory', () => {
  it('returns the story from a good answer', async () => {
    const chatFn = vi.fn<ChatFn>().mockResolvedValue(answer(JSON.stringify(goodDraft)));
    const config = await generateStory({ ...req, stageCount: 3 }, llm, chatFn);
    expect(config.mod_name_en).toBe('The Lantern Card');
    expect(chatFn).toHaveBeenCalledTimes(1);
    expect(chatFn.mock.calls[0][1]).toEqual([]);
  });

  it('retries once with the problems, then succeeds', async () => {
    const chatFn = vi
      .fn<ChatFn>()
      .mockResolvedValueOnce(answer('not json'))
      .mockResolvedValueOnce(answer(JSON.stringify(goodDraft)));
    const config = await generateStory(req, llm, chatFn);
    expect(config.stage_count).toBe(3);
    const retry = chatFn.mock.calls[1][0];
    expect(retry[retry.length - 1].content).toContain('not valid JSON');
  });

  it('gives up after two invalid answers and clamps the stage count', async () => {
    const chatFn = vi
      .fn<ChatFn>()
      .mockResolvedValue(answer(JSON.stringify({ ...goodDraft, title: '' })));
    await expect(generateStory({ ...req, stageCount: 1 }, llm, chatFn)).rejects.toThrow(
      /could not write a valid story: .*"title" is missing/,
    );
    // stageCount 1 is raised to the minimum of 3, which the draft satisfies apart from the title
    expect(chatFn.mock.calls[0][0][0].content).toContain('Exactly 3 stages');
    expect(chatFn).toHaveBeenCalledTimes(2);
  });

  it('handles a null answer and requires a character', async () => {
    const chatFn = vi.fn<ChatFn>().mockResolvedValue(answer(null));
    await expect(generateStory(req, llm, chatFn)).rejects.toThrow('not valid JSON');
    await expect(generateStory({ ...req, characters: [] }, llm, chatFn)).rejects.toThrow(
      'at least one character',
    );
  });
});

describe('reviseNextStage', () => {
  const config: ModConfig = {
    id: 'tavern',
    mod_name: 'T',
    mod_name_en: 'Tavern',
    mod_description: 'setting',
    stage_count: 2,
    stages: {
      0: {
        stage_index: 0,
        stage_name: 'Booth',
        stage_description: 'meet',
        stage_targets: { 1: 'a' },
      },
      1: {
        stage_index: 1,
        stage_name: 'Cellar',
        stage_description: 'play',
        stage_targets: { 2: 'b', 3: 'c' },
      },
    },
    cast: [{ id: 'pell', name: 'Pell', gender: 'F', role: 'barmaid', persona: 'dry' }],
  };
  const state: ModState = {
    current_stage_index: 1,
    total_stage_count: 2,
    is_finished: false,
    completed_targets: [1],
    plot_log: ['Trusted Pell'],
    cast_state: { pell: { attitude: 'loyal', knows: [], notes: ['lied to Varga'] } },
  };

  it('builds no request when there is nothing to revise', () => {
    expect(buildReviseMessages({ ...config, cast: [] }, state)).toBeNull();
    expect(buildReviseMessages(config, { ...state, is_finished: true })).toBeNull();
    expect(buildReviseMessages(config, { ...state, current_stage_index: 5 })).toBeNull();
  });

  it('describes the choices and cast', () => {
    const msgs = buildReviseMessages(config, state)!;
    expect(msgs[1].content).toContain('- Trusted Pell');
    expect(msgs[1].content).toContain('Feels: loyal');
    expect(msgs[1].content).toContain('- Booth: meet');
    expect(msgs[1].content).toContain('"2": "b"');
    const bare = buildReviseMessages(config, {
      ...state,
      plot_log: undefined,
      cast_state: undefined,
    })!;
    expect(bare[1].content).toContain('(none recorded)');
    expect(bare[1].content).toContain('Feels: unknown');
  });

  it('rewrites the stage keeping ids and name', async () => {
    const chatFn = vi
      .fn<ChatFn>()
      .mockResolvedValue(
        answer('{"description":"Pell sneaks you in","targets":{"2":"B2","3":"C2"}}'),
      );
    const revised = await reviseNextStage(config, state, llm, chatFn);
    expect(revised!.stages[1]).toEqual({
      stage_index: 1,
      stage_name: 'Cellar',
      stage_description: 'Pell sneaks you in',
      stage_targets: { 2: 'B2', 3: 'C2' },
    });
    expect(revised!.stages[0]).toBe(config.stages[0]);
  });

  it('keeps the original on bad answers or errors', async () => {
    const missing = vi
      .fn<ChatFn>()
      .mockResolvedValue(answer('{"description":"x","targets":{"2":"B"}}'));
    expect(await reviseNextStage(config, state, llm, missing)).toBeNull();
    const noTargets = vi.fn<ChatFn>().mockResolvedValue(answer('{"description":"x"}'));
    expect(await reviseNextStage(config, state, llm, noTargets)).toBeNull();
    const failing = vi.fn<ChatFn>().mockRejectedValue(new Error('down'));
    expect(await reviseNextStage(config, state, llm, failing)).toBeNull();
    const none = vi.fn<ChatFn>();
    expect(await reviseNextStage(config, { ...state, is_finished: true }, llm, none)).toBeNull();
    expect(none).not.toHaveBeenCalled();
  });
});
