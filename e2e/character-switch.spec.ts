import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * Regression: when the server's character list (active = Kestrel) arrives after
 * the page started on the built-in default (Aoi), Aoi's chat history must never
 * be shown as, or saved into, Kestrel's history.
 */

const AOI_LINE = 'AOI_ONLY_LINE: eighty years on ice';

const collection = {
  activeId: 'kestrel',
  items: {
    aoi: {
      id: 'aoi',
      character_name: 'Aoi',
      character_gender_desc: 'Female',
      character_desc: 'Aoi test persona',
      character_emotion_list: ['default'],
    },
    kestrel: {
      id: 'kestrel',
      character_name: 'Kestrel Vane',
      character_gender_desc: 'Female',
      character_desc: 'Kestrel test persona',
      character_emotion_list: ['default'],
    },
  },
};

const aoiHistory = {
  version: 1,
  savedAt: 1,
  messages: [
    { id: 'prologue', role: 'assistant', content: 'Prologue' },
    { id: 'u1', role: 'user', content: 'Who are you' },
    { id: 'a1', role: 'assistant', content: AOI_LINE },
  ],
  chatHistory: [
    { role: 'assistant', content: 'Prologue' },
    { role: 'user', content: 'Who are you' },
    { role: 'assistant', content: AOI_LINE },
  ],
  suggestedReplies: [],
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mock the character list and session storage; record every chat save per character. */
async function setup(
  page: Page,
  opts: { charactersDelay: number; aoiHistoryDelay: number; kestrelHistoryDelay?: number },
) {
  const saves: { path: string; body: string }[] = [];
  await page.route('**/api/characters', async (route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    await delay(opts.charactersDelay);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(collection),
    });
  });
  await page.route('**/api/session-data**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).searchParams.get('path') ?? '';
    if (req.method() === 'GET') {
      if (path.startsWith('aoi/') && path.endsWith('/chat/chat.json')) {
        await delay(opts.aoiHistoryDelay);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(aoiHistory),
        });
      }
      if (path.startsWith('kestrel/')) await delay(opts.kestrelHistoryDelay ?? 0);
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    saves.push({ path, body: req.postData() ?? '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  return saves;
}

async function expectKestrelClean(page: Page, saves: { path: string; body: string }[]) {
  const messages = page.locator('[data-testid="chat-message"]');
  // Kestrel starts fresh with the mod's prologue...
  await expect(messages.first()).toBeVisible();
  // ...and give any late load / pending save time to (wrongly) land.
  await page.waitForTimeout(2500);
  await expect(page.locator('[data-testid="chat-messages"]')).not.toContainText(AOI_LINE);
  const kestrelSaves = saves.filter((s) => s.path.startsWith('kestrel/'));
  expect(kestrelSaves.length).toBeGreaterThan(0);
  for (const s of kestrelSaves) expect(s.body).not.toContain(AOI_LINE);
}

test.describe('Character switch on startup keeps chat histories apart', () => {
  test('a late Aoi history load is not shown or saved as Kestrel', async ({ page }) => {
    // Switch to Kestrel at ~0.5 s; Aoi's history only arrives at ~2 s.
    const saves = await setup(page, { charactersDelay: 500, aoiHistoryDelay: 2000 });
    await page.goto('/');
    await expectKestrelClean(page, saves);
  });

  test("a pending save of Aoi's chat is not written to Kestrel", async ({ page }) => {
    // Aoi's history arrives at ~0.2 s (save scheduled for ~0.7 s), the switch to Kestrel
    // happens at ~0.4 s, and Kestrel's own (empty) history only arrives at ~1.4 s.
    const saves = await setup(page, {
      charactersDelay: 400,
      aoiHistoryDelay: 200,
      kestrelHistoryDelay: 1000,
    });
    await page.goto('/');
    await expectKestrelClean(page, saves);
  });
});

test.describe('Avatar on a startup character switch', () => {
  test("a late-loading video of the previous character doesn't replace the new one", async ({
    page,
  }) => {
    const webm = readFileSync(join(__dirname, 'fixtures', 'avatar.webm'));
    const withVideos = {
      ...collection,
      items: {
        ...collection.items,
        kestrel: {
          ...collection.items.kestrel,
          character_meta_info: { emotion_videos: { default: ['/test-avatar/kestrel.webm'] } },
        },
      },
    };
    // Aoi's built-in CDN video (shown first) only finishes loading just after
    // Kestrel's video is ready, when it is no longer the one that should show.
    let kestrelServed: () => void = () => {};
    const kestrelReady = new Promise<void>((r) => (kestrelServed = r));
    await page.route('https://cdn.openroom.ai/**', async (route) => {
      await kestrelReady;
      await delay(150);
      return route.fulfill({ status: 200, contentType: 'video/webm', body: webm });
    });
    await page.route('**/test-avatar/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'video/webm', body: webm });
      kestrelServed();
    });
    await page.route('**/api/characters', async (route) => {
      await delay(300);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(withVideos),
      });
    });
    await page.route('**/api/session-data**', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/');

    const kestrelVideo = page.locator('video[src*="kestrel.webm"]');
    await expect(kestrelVideo).toHaveCSS('opacity', '1');
    // After Aoi's video has loaded too, Kestrel is still the one shown.
    await page.waitForTimeout(2500);
    await expect(kestrelVideo).toHaveCSS('opacity', '1');
    await expect(page.locator('video')).toHaveCount(1);
  });
});
