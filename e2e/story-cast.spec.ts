import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Stories with a cast: the model hands the scene to another cast member, the user
 * picks who to talk to, cast memory and choices are saved, and new stories can be
 * written from the Story Mods panel. The LLM and all storage are mocked.
 */

const llm = { provider: 'openai', apiKey: 'k', baseUrl: 'http://llm.test/v1', model: 'm' };

const characters = {
  activeId: 'kestrel',
  items: {
    aoi: {
      id: 'aoi',
      character_name: 'Aoi',
      character_gender_desc: 'Female',
      character_desc: 'A bounty hunter.',
      character_emotion_list: ['default'],
    },
    kestrel: {
      id: 'kestrel',
      character_name: 'Kestrel Vane',
      character_gender_desc: 'Female',
      character_desc: 'A half-elf card sharp.',
      character_emotion_list: ['default'],
    },
  },
};

function tavernMods(extraState: Record<string, unknown> = {}) {
  return {
    activeId: 'tavern',
    items: {
      tavern: {
        config: {
          id: 'tavern',
          mod_name: 'The Lantern Card',
          mod_name_en: 'The Lantern Card',
          mod_description: 'A riverside tavern.',
          stage_count: 1,
          prologue: '(flips a card) Evening, stranger.',
          stages: {
            0: {
              stage_index: 0,
              stage_name: 'The Corner Booth',
              stage_description: 'Meet the user.',
              stage_targets: { 1: 'Do a card trick' },
            },
          },
          lead_id: 'kestrel',
          cast: [
            {
              id: 'kestrel',
              name: 'Kestrel Vane',
              gender: 'Female',
              role: 'card sharp',
              persona: 'Counting her winnings.',
              character_id: 'kestrel',
            },
            {
              id: 'pell',
              name: 'Pell',
              gender: 'Female',
              role: 'barmaid',
              persona: 'Dry wit.',
              secret: 'She saw the collector palm the card.',
            },
            {
              id: 'osric',
              name: 'Osric Fenn',
              gender: 'Male',
              role: 'barge captain',
              persona: 'Loud and cheerful.',
            },
          ],
        },
        state: {
          current_stage_index: 0,
          total_stage_count: 1,
          is_finished: false,
          completed_targets: [],
          ...extraState,
        },
      },
    },
  };
}

type ToolCall = { name: string; args: Record<string, unknown> };
type LLMRequest = { messages: Array<{ role: string; content: string | null }>; tools?: unknown[] };

const toolsReply = (calls: ToolCall[]) => ({
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map((c, i) => ({
          id: `call_${Date.now()}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      },
    },
  ],
});
const textReply = (text: string) => ({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
});
const say = (content: string): ToolCall => ({
  name: 'respond_to_user',
  args: { character_expression: { content }, user_interaction: { suggested_replies: ['Go on'] } },
});

/**
 * Mock storage and the LLM. `mods` is stateful: GET returns the last saved collection.
 * `replies` are served in order; extra requests end the turn.
 */
async function setup(page: Page, opts: { mods: unknown | null; replies: unknown[] }) {
  let mods = opts.mods;
  const modSaves: Array<Record<string, any>> = [];
  const sessionSaves: string[] = [];
  const requests: LLMRequest[] = [];
  const replies = [...opts.replies];

  await page.route('**/api/characters', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(characters),
        })
      : route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  await page.route('**/api/mods', (route) => {
    if (route.request().method() === 'GET') {
      return mods
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(mods),
          })
        : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    mods = JSON.parse(route.request().postData() ?? '{}');
    modSaves.push(mods as Record<string, any>);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/session-data**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    sessionSaves.push(new URL(req.url()).searchParams.get('path') ?? '');
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/llm-config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ llm }) }),
  );
  const fulfillLLM = (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204 });
    requests.push(JSON.parse(route.request().postData() ?? '{}'));
    const next = replies.shift() ?? textReply('');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(next),
    });
  };
  await page.route('**/api/llm-proxy', fulfillLLM);
  await page.route('http://llm.test/**', fulfillLLM);
  return { modSaves, sessionSaves, requests, lastMods: () => mods as Record<string, any> };
}

const systemOf = (r: LLMRequest) => r.messages[0]?.content ?? '';

async function send(page: Page, text: string) {
  await page.locator('[data-testid="chat-input"]').fill(text);
  await page.locator('[data-testid="send-btn"]').click();
}

test.describe('Story cast', () => {
  test('the story hands the scene to another cast member', async ({ page }) => {
    const io = await setup(page, {
      mods: tavernMods(),
      replies: [
        toolsReply([
          say('(waves) Pell! This one wants a cider.'),
          { name: 'switch_speaker', args: { cast_id: 'pell', reason: 'ordering' } },
        ]),
        toolsReply([say('(wipes a mug) Cider it is. Mind her cards.')]),
      ],
    });
    await page.goto('/');

    const speaker = page.locator('[data-testid="speaker-name"]');
    await expect(speaker).toHaveText('Kestrel Vane');
    await expect(page.locator('[data-testid="cast-bar"]')).toBeVisible();
    // Pell has not met the user yet: shown as an unknown chip
    await expect(page.locator('[data-testid="cast-chip-pell"]')).toHaveText('?');
    // The prologue is labelled with the lead
    await expect(page.locator('[data-testid="speaker-label"]').first()).toHaveText('Kestrel Vane');

    await send(page, 'Can I get a drink?');

    const messages = page.locator('[data-testid="chat-messages"]');
    await expect(messages).toContainText('Cider it is.');
    await expect(speaker).toHaveText('Pell');
    const labels = page.locator('[data-testid="speaker-label"]');
    await expect(labels).toHaveText(['Kestrel Vane', 'Kestrel Vane', 'Pell']);
    await expect(page.locator('[data-testid="cast-chip-pell"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // The first request was played by Kestrel, the second by Pell (who knows her secret)
    expect(systemOf(io.requests[0])).toContain('You are speaking as Kestrel Vane');
    expect(systemOf(io.requests[0])).not.toContain('palm the card');
    expect(systemOf(io.requests[1])).toContain('You are speaking as Pell');
    expect(systemOf(io.requests[1])).toContain('palm the card');
    // The cast tools are offered
    const toolNames = (io.requests[0].tools as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(toolNames).toEqual(
      expect.arrayContaining(['switch_speaker', 'update_cast', 'record_choice']),
    );

    // The speaker is saved, and the chat goes to the story's shared session
    await expect.poll(() => io.lastMods().items.tavern.state.speaker_id).toBe('pell');
    await expect.poll(() => io.sessionSaves.some((p) => p.startsWith('_story/tavern/'))).toBe(true);
    expect(io.sessionSaves.some((p) => p.startsWith('kestrel/'))).toBe(false);
  });

  test('the user picks who to talk to; memory and choices survive a reload', async ({ page }) => {
    const io = await setup(page, {
      mods: tavernMods({ cast_state: { osric: { introduced: true, knows: [], notes: [] } } }),
      replies: [
        toolsReply([
          {
            name: 'update_cast',
            args: { cast_id: 'osric', attitude: 'warming up', learned: 'You buy rounds' },
          },
          { name: 'record_choice', args: { summary: 'Bought Osric a drink' } },
          say('(raises his mug) Aye, a friend of the river!'),
        ]),
      ],
    });
    await page.goto('/');
    await expect(page.locator('[data-testid="speaker-name"]')).toHaveText('Kestrel Vane');

    await page.locator('[data-testid="cast-chip-osric"]').click();
    await expect(page.locator('[data-testid="speaker-name"]')).toHaveText('Osric Fenn');
    await expect(page.locator('[data-testid="chat-messages"]')).toContainText(
      'You turn to Osric Fenn.',
    );

    await send(page, 'A round for the captain!');
    await expect(page.locator('[data-testid="chat-messages"]')).toContainText(
      'friend of the river',
    );
    expect(systemOf(io.requests[0])).toContain('You are speaking as Osric Fenn');

    await expect
      .poll(() => io.lastMods().items.tavern.state.plot_log)
      .toEqual(['Bought Osric a drink']);
    const osric = io.lastMods().items.tavern.state.cast_state.osric;
    expect(osric).toMatchObject({ attitude: 'warming up', knows: ['You buy rounds'] });

    // After a reload the speaker and memory are still there and reach the model
    await page.reload();
    await expect(page.locator('[data-testid="speaker-name"]')).toHaveText('Osric Fenn');
    await expect(page.locator('[data-testid="cast-chip-osric"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const before = io.requests.length;
    await send(page, 'Remember me?');
    await expect.poll(() => io.requests.length).toBeGreaterThan(before);
    const sys = systemOf(io.requests[before]);
    expect(sys).toContain('Feels about the user: warming up.');
    expect(sys).toContain('- Bought Osric a drink');
  });

  test('writes a new story with a cast from the Story Mods panel', async ({ page }) => {
    const draft = {
      title: 'Crash at the Heron',
      setting: "Aoi's ship crash-lands behind Kestrel's tavern.",
      display_desc: 'A starship in a fantasy river town. Genre: Crossover',
      prologue: '(peers at the smoking wreck) Well. That is new.',
      opening_replies: ['What happened?', 'Is anyone hurt?', 'Who is she?'],
      lead_id: 'kes',
      cast: [
        {
          id: 'kes',
          name: 'Kestrel',
          character_id: 'kestrel',
          role: 'tavern card sharp',
          persona: 'Curious.',
        },
        { id: 'aoi', name: 'Aoi', character_id: 'aoi', role: 'stranded pilot', persona: 'Grumpy.' },
        {
          id: 'mayor',
          name: 'Mayor Brill',
          role: 'town mayor',
          persona: 'Pompous.',
          secret: 'Owes Varga.',
        },
      ],
      stages: [
        { name: 'The Wreck', description: 'Find the ship.', targets: ['Reach the wreck'] },
        { name: 'The Mayor', description: 'Deal with the mayor.', targets: ['Calm the town'] },
        {
          name: 'Liftoff',
          description: 'Repair the ship.',
          targets: ['Aoi decides to stay or go'],
        },
      ],
    };
    const io = await setup(page, { mods: null, replies: [textReply(JSON.stringify(draft))] });
    await page.goto('/');

    // The default story has no cast
    await expect(page.locator('[data-testid="speaker-name"]')).toHaveText('Kestrel Vane');
    await expect(page.locator('[data-testid="cast-bar"]')).toHaveCount(0);

    await page.locator('[data-testid="story-indicator"]').click();
    await page.locator('[data-testid="write-story"]').click();
    await expect(page.locator('[data-testid="story-char-kestrel"]')).toBeChecked();
    await page.locator('[data-testid="story-char-aoi"]').check();
    await page.locator('[data-testid="story-premise"]').fill('Aoi crash-lands near the tavern');
    await page.locator('[data-testid="story-stages"]').fill('3');
    await page.locator('[data-testid="story-generate"]').click();

    const preview = page.locator('[data-testid="story-preview"]');
    await expect(preview).toContainText('Crash at the Heron');
    await expect(preview).toContainText('Mayor Brill');
    await expect(preview).toContainText('Liftoff');

    // The model got both characters and the wishes, without tools
    const req = io.requests[0];
    expect(req.tools).toBeUndefined();
    expect(req.messages[1].content).toContain('character_id: "kestrel"');
    expect(req.messages[1].content).toContain('character_id: "aoi"');
    expect(req.messages[1].content).toContain('Aoi crash-lands near the tavern');
    expect(req.messages[0].content).toContain('Exactly 3 stages');

    await page.locator('[data-testid="story-create"]').click();
    await expect(page.locator('[data-testid="story-generator"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="cast-bar"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-messages"]')).toContainText('That is new.');
    await expect(page.locator('[data-testid="speaker-label"]').first()).toHaveText('Kestrel Vane');
    await expect(page.locator('[data-testid="cast-chip-aoi"]')).toHaveText('?');

    const saved = io.lastMods();
    const story = saved.items[saved.activeId].config;
    expect(story.mod_name_en).toBe('Crash at the Heron');
    expect(story.cast.map((m: { id: string }) => m.id)).toEqual(['kes', 'aoi', 'mayor']);
    expect(story.lead_id).toBe('kes');
    expect(Object.keys(saved.items)).toContain('space_adventure');
  });

  test('shows the problem when the model cannot write a story', async ({ page }) => {
    await setup(page, { mods: null, replies: [textReply('nope'), textReply('still nope')] });
    await page.goto('/');
    await page.locator('[data-testid="story-indicator"]').click();
    await page.locator('[data-testid="write-story"]').click();
    await page.locator('[data-testid="story-generate"]').click();
    await expect(page.locator('[data-testid="story-error"]')).toContainText(
      'could not write a valid story',
    );
  });
});
