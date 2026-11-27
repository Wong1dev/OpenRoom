import { test, expect, type Page } from '@playwright/test';

/**
 * Give the app a usable LLM config and a canned LLM reply, so sending a message
 * works the same on every machine (no ~/.openroom/config.json or network needed).
 */
async function mockLLM(page: Page) {
  const llm = {
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'http://llm.test/v1',
    model: 'test-model',
  };
  // Start from an empty session and keep test chats out of ~/.openroom/sessions
  await page.route('**/api/session-data**', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  await page.route('**/api/llm-config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ llm }) }),
  );
  const reply = {
    choices: [{ message: { role: 'assistant', content: 'Mock reply' }, finish_reason: 'stop' }],
  };
  const fulfillLLM = (route: import('@playwright/test').Route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204 })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(reply),
        });
  await page.route('**/api/llm-proxy', fulfillLLM);
  await page.route('http://llm.test/**', fulfillLLM);
}

test.describe('Shell – main UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('renders the shell with desktop app icons', async ({ page }) => {
    await expect(page).toHaveTitle('OpenRoom');
    const shell = page.locator('[data-testid="shell"]');
    await expect(shell).toBeVisible();

    const desktop = page.locator('[data-testid="desktop"]');
    await expect(desktop).toBeVisible();

    // Should have multiple app icons on the desktop
    const icons = page.locator('[data-testid^="app-icon-"]');
    await expect(icons).not.toHaveCount(0);
    const count = await icons.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('displays control buttons (chat, lang, wallpaper, report)', async ({ page }) => {
    await expect(page.locator('[data-testid="chat-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="lang-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="wallpaper-toggle"]')).toBeVisible();
    await expect(page.locator('[data-testid="report-toggle"]')).toBeVisible();
  });
});

test.describe('Chat panel – visibility toggle', () => {
  test('chat panel is visible by default and can be hidden and re-shown', async ({ page }) => {
    await page.goto('/');
    const panel = page.locator('[data-testid="chat-panel"]');
    const toggle = page.locator('[data-testid="chat-toggle"]');

    // Panel visible by default
    await expect(panel).toBeVisible();
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();

    // Hide it
    await toggle.click();
    await expect(panel).not.toBeVisible();

    // Show it again
    await toggle.click();
    await expect(panel).toBeVisible();
  });

  test('chat panel shows either setup hint or chat messages', async ({ page }) => {
    await page.goto('/');
    const messages = page.locator('[data-testid="chat-messages"]');
    await expect(messages).toBeVisible();

    const emptyStateHint = messages.getByText(/configure your LLM API key|is ready to chat/i);
    const chatMessages = page.locator('[data-testid="chat-message"]');

    await expect
      .poll(async () => {
        return (await emptyStateHint.count()) + (await chatMessages.count());
      })
      .toBeGreaterThan(0);
  });
});

test.describe('Chat panel – settings modal', () => {
  test('opens and closes the settings modal', async ({ page }) => {
    await page.goto('/');
    const settingsBtn = page.locator('[data-testid="settings-btn"]');
    await expect(settingsBtn).toBeVisible();

    // Open settings
    await settingsBtn.click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('LLM Settings');

    // Close via Cancel button
    await modal.locator('button', { hasText: 'Cancel' }).click();
    await expect(modal).not.toBeVisible();
  });
});

test.describe('Chat panel – input interaction', () => {
  test('send button is disabled when input is empty and enabled when text is entered', async ({
    page,
  }) => {
    await page.goto('/');
    const input = page.locator('[data-testid="chat-input"]');
    const sendBtn = page.locator('[data-testid="send-btn"]');

    // Initially disabled
    await expect(sendBtn).toBeDisabled();

    // Type something
    await input.fill('Hello');
    await expect(sendBtn).toBeEnabled();

    // Clear it
    await input.fill('');
    await expect(sendBtn).toBeDisabled();
  });

  test('typing a message and clicking send adds it to the messages area', async ({ page }) => {
    await mockLLM(page);
    await page.goto('/');
    const input = page.locator('[data-testid="chat-input"]');
    const sendBtn = page.locator('[data-testid="send-btn"]');
    const messages = page.locator('[data-testid="chat-messages"]');

    await input.fill('Test message from E2E');
    await sendBtn.click();

    // The user message should appear in the messages area
    await expect(messages).toContainText('Test message from E2E');
    // Input should be cleared after sending
    await expect(input).toHaveValue('');
  });

  test('pressing Enter on desktop sends and keeps the input focused', async ({ page }) => {
    await mockLLM(page);
    await page.goto('/');
    const input = page.locator('[data-testid="chat-input"]');

    await input.fill('Desktop enter message');
    await input.press('Enter');

    await expect(page.locator('[data-testid="chat-messages"]')).toContainText(
      'Desktop enter message',
    );
    await expect(input).toBeFocused();
  });
});

test.describe('Chat panel – mobile keyboard', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('pressing Enter sends the message and dismisses the keyboard', async ({ page }) => {
    await mockLLM(page);
    await page.goto('/');
    const input = page.locator('[data-testid="chat-input"]');
    await expect(input).toHaveAttribute('enterkeyhint', 'send');

    await input.tap();
    await input.fill('Mobile enter message');
    await expect(input).toBeFocused();
    await input.press('Enter');

    await expect(page.locator('[data-testid="chat-messages"]')).toContainText(
      'Mobile enter message',
    );
    await expect(input).toHaveValue('');
    // Blurring the textarea is what closes the on-screen keyboard
    await expect(input).not.toBeFocused();
  });

  test('chat panel fits the visible viewport height', async ({ page }) => {
    await page.goto('/');
    const box = await page.locator('[data-testid="chat-panel"]').boundingBox();
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(box).not.toBeNull();
    expect(Math.round(box!.height)).toBeLessThanOrEqual(viewportHeight);
    await expect(page.locator('[data-testid="chat-input"]')).toBeInViewport();
  });

  test('chat input and send button are not covered by the floating controls', async ({ page }) => {
    await page.goto('/');
    for (const testId of ['chat-input', 'send-btn']) {
      const target = page.locator(`[data-testid="${testId}"]`);
      await expect(target).toBeVisible();
      const hitsSelf = await target.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const points = [
          [r.left + 4, r.top + r.height / 2],
          [r.left + r.width / 2, r.top + r.height / 2],
          [r.right - 4, r.top + r.height / 2],
        ];
        return points.every(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return !!hit && (hit === el || el.contains(hit));
        });
      });
      expect(hitsSelf, `${testId} is covered by another element`).toBe(true);
    }
  });
});

test.describe('App window – open and close', () => {
  test('double-clicking an app icon opens a window, closing it removes the window', async ({
    page,
  }) => {
    await page.goto('/');

    // Double-click the Twitter icon (appId=2)
    const twitterIcon = page.locator('[data-testid="app-icon-2"]');
    await expect(twitterIcon).toBeVisible();
    await twitterIcon.dblclick();

    // An app window should appear
    const appWindow = page.locator('[data-testid="app-window-2"]');
    await expect(appWindow).toBeVisible({ timeout: 10000 });

    // Close it
    const closeBtn = page.locator('[data-testid="window-close-2"]');
    await closeBtn.click();
    await expect(appWindow).not.toBeVisible();
  });
});

test.describe('Language toggle', () => {
  test('clicking the language toggle changes its label', async ({ page }) => {
    await page.goto('/');
    const langBtn = page.locator('[data-testid="lang-toggle"]');

    // Default is EN
    await expect(langBtn).toContainText('EN');

    // Toggle to ZH
    await langBtn.click();
    await expect(langBtn).toContainText('ZH');

    // Toggle back
    await langBtn.click();
    await expect(langBtn).toContainText('EN');
  });
});

/**
 * Mock an LLM that answers with a respond_to_user tool call (the real chat format),
 * and record speech instead of playing it.
 */
type ReplyMode =
  | 'tool' // respond_to_user tool call, then an empty final turn
  | 'plain' // plain text only, no tool call
  | 'tool-then-echo'; // tool call, then the same text again as plain text

async function mockCharacterReply(
  page: Page,
  content: string,
  replies: string[],
  mode: ReplyMode = 'tool',
) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const spoken: string[] = [];
    w.__spoken = spoken;
    w.__silent = 0;
    class FakeUtterance {
      text: string;
      voice: unknown = null;
      lang = '';
      rate = 1;
      pitch = 1;
      volume = 1;
      constructor(text: string) {
        this.text = text;
      }
    }
    const synth = {
      getVoices: () => [
        { name: 'Fred', lang: 'en-US', localService: true },
        { name: 'Samantha', lang: 'en-US', localService: true },
      ],
      speak: (u: FakeUtterance) => {
        if (u.volume > 0) spoken.push(`${(u.voice as { name: string } | null)?.name}: ${u.text}`);
        else w.__silent = (w.__silent as number) + 1;
      },
      cancel: () => {},
      resume: () => {},
      speaking: false,
      pending: false,
      paused: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: FakeUtterance,
      configurable: true,
    });
  });
  await mockLLM(page);
  const toolReply = {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'respond_to_user',
                arguments: JSON.stringify({
                  character_expression: { content, emotion: 'happy' },
                  user_interaction: { suggested_replies: replies },
                }),
              },
            },
          ],
        },
      },
    ],
  };
  const plain = (text: string) => ({
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  });
  // After the tool result comes back, end the turn (or echo the reply, as some models do).
  const done = plain(mode === 'tool-then-echo' ? content : '');
  const fulfill = (route: import('@playwright/test').Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204 });
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      messages?: Array<{ role: string }>;
    };
    const afterTool = body.messages?.at(-1)?.role === 'tool';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mode === 'plain' ? plain(content) : afterTool ? done : toolReply),
    });
  };
  await page.unroute('**/api/llm-proxy');
  await page.unroute('http://llm.test/**');
  await page.route('**/api/llm-proxy', fulfill);
  await page.route('http://llm.test/**', fulfill);
}

test.describe('Chat panel – user name placeholders', () => {
  test('replaces [name] in replies and hides placeholder suggestions', async ({ page }) => {
    await mockCharacterReply(page, "(grins) I don't take 'just [name]' for an answer.", [
      "It's [name]. And yours?",
      'Why does it matter?',
    ]);
    await page.goto('/');
    await page.locator('[data-testid="chat-input"]').fill('Hello');
    await page.locator('[data-testid="send-btn"]').click();

    const messages = page.locator('[data-testid="chat-messages"]');
    await expect(messages).toContainText("I don't take 'just you' for an answer.");
    await expect(messages).not.toContainText('[name]');
    const suggestions = page.locator('[data-testid="suggested-reply"]');
    await expect(suggestions).toHaveCount(1);
    await expect(suggestions.first()).toHaveText('Why does it matter?');
  });
});

test.describe('Chat panel – voice', () => {
  test('voice toggle reads replies aloud with a female voice, and mutes', async ({ page }) => {
    await mockCharacterReply(page, '(smiles) Welcome aboard, traveler!', ['Thanks!']);
    await page.goto('/');
    const toggle = page.locator('[data-testid="tts-toggle"]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await page.locator('[data-testid="chat-input"]').fill('Hi');
    await page.locator('[data-testid="send-btn"]').click();
    await expect(page.locator('[data-testid="chat-messages"]')).toContainText('Welcome aboard');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken))
      .toEqual(['Samantha: Voice on.', 'Samantha: Welcome aboard, traveler!']);

    // Preference survives a reload; the first tap of the new page load unlocks speech (Safari)
    await page.reload();
    await expect(page.locator('[data-testid="tts-toggle"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const silent = () => page.evaluate(() => (window as unknown as { __silent: number }).__silent);
    expect(await silent()).toBe(0);
    await page.locator('[data-testid="chat-input"]').click();
    expect(await silent()).toBe(1);
    await page.locator('[data-testid="chat-input"]').click();
    expect(await silent()).toBe(1);

    // Muting stops further speech
    await page.locator('[data-testid="tts-toggle"]').click();
    await expect(page.locator('[data-testid="tts-toggle"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await page.locator('[data-testid="chat-input"]').fill('Again');
    await page.locator('[data-testid="send-btn"]').click();
    await expect(page.locator('[data-testid="chat-message"]').last()).toContainText('Welcome');
    expect(
      await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken),
    ).toEqual([]);
  });
});

test.describe('Chat panel – replies without the respond_to_user tool', () => {
  const spoken = (page: Page) =>
    page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken);

  test('a plain-text reply is shown, cleaned and spoken', async ({ page }) => {
    await mockCharacterReply(page, "(leans in) The name's Aoi. And you, [name]?", [], 'plain');
    await page.goto('/');
    await page.locator('[data-testid="tts-toggle"]').click();
    await page.locator('[data-testid="chat-input"]').fill('Who are you');
    await page.locator('[data-testid="send-btn"]').click();

    const last = page.locator('[data-testid="chat-message"]').last();
    await expect(last).toContainText("The name's Aoi. And you, you?");
    await expect
      .poll(() => spoken(page))
      .toEqual(['Samantha: Voice on.', "Samantha: The name's Aoi. And you, you?"]);
  });

  test('a plain-text echo after respond_to_user is not shown or spoken twice', async ({ page }) => {
    await mockCharacterReply(page, 'René... Nice ring to it.', ['Thanks'], 'tool-then-echo');
    await page.goto('/');
    await page.locator('[data-testid="tts-toggle"]').click();
    await page.locator('[data-testid="chat-input"]').fill('René');
    await page.locator('[data-testid="send-btn"]').click();

    await expect(page.locator('[data-testid="suggested-reply"]')).toHaveText(['Thanks']);
    await expect(
      page.locator('[data-testid="chat-message"]').filter({ hasText: 'Nice ring to it' }),
    ).toHaveCount(1);
    expect(await spoken(page)).toEqual([
      'Samantha: Voice on.',
      'Samantha: René... Nice ring to it.',
    ]);
  });
});

test.describe('Image generation – Pollinations (free, no key)', () => {
  const llm = {
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'http://llm.test/v1',
    model: 'test-model',
  };
  const pollinations = {
    provider: 'pollinations',
    apiKey: '',
    baseUrl: 'https://image.pollinations.ai',
    model: 'flux',
  };
  // 1x1 transparent PNG
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );

  test('can be chosen in Settings without an API key', async ({ page }) => {
    await mockLLM(page);
    const saved: unknown[] = [];
    await page.route('**/api/llm-config', (route) => {
      if (route.request().method() === 'POST') saved.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ llm }),
      });
    });
    await page.goto('/');
    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await modal.locator('[data-testid="image-provider"]').selectOption('pollinations');
    await modal.locator('button', { hasText: 'Save' }).click();
    await expect(modal).not.toBeVisible();

    await expect.poll(() => saved.length).toBeGreaterThan(0);
    expect(saved.at(-1)).toMatchObject({ imageGen: pollinations });
  });

  test('Cloudflare Workers AI is set up in Settings and draws through the proxy', async ({
    page,
  }) => {
    await mockLLM(page);
    const saved: Array<{ imageGen?: Record<string, string> }> = [];
    let served = { llm } as Record<string, unknown>;
    await page.route('**/api/llm-config', (route) => {
      if (route.request().method() === 'POST') {
        served = route.request().postDataJSON();
        saved.push(served as never);
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(served),
      });
    });
    await page.goto('/');
    await page.locator('[data-testid="settings-btn"]').click();
    const modal = page.locator('[data-testid="settings-modal"]');
    await modal.locator('[data-testid="image-provider"]').selectOption('cloudflare');
    const baseUrl = modal.locator('[data-testid="image-base-url"]');
    await expect(baseUrl).toHaveValue(/YOUR_ACCOUNT_ID/);
    await expect(modal.locator('[data-testid="image-account-hint"]')).toBeVisible();
    await baseUrl.fill('https://api.cloudflare.com/client/v4/accounts/acc42');
    await expect(modal.locator('[data-testid="image-account-hint"]')).toHaveCount(0);
    await modal.getByPlaceholder('API Key...').last().fill('cf-token');
    await modal.locator('button', { hasText: 'Save' }).click();
    await expect(modal).not.toBeVisible();
    await expect
      .poll(() => saved.at(-1)?.imageGen)
      .toMatchObject({
        provider: 'cloudflare',
        apiKey: 'cf-token',
        baseUrl: 'https://api.cloudflare.com/client/v4/accounts/acc42',
        model: '@cf/black-forest-labs/flux-1-schnell',
      });

    // The model asks for a picture; it is drawn by Cloudflare via the proxy.
    const cfTargets: string[] = [];
    await page.unroute('**/api/llm-proxy');
    await page.unroute('http://llm.test/**');
    const fulfill = (route: import('@playwright/test').Route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204 });
      const target = route.request().headers()['x-llm-target-url'] ?? '';
      if (target.includes('api.cloudflare.com')) {
        cfTargets.push(target);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, result: { image: PNG.toString('base64') } }),
        });
      }
      const body = route.request().postDataJSON() as {
        messages: Array<{ role: string; tool_call_id?: string }>;
      };
      const last = body.messages.at(-1);
      const call = (name: string, args: unknown) => ({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${name}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
      });
      const reply =
        last?.role !== 'tool'
          ? call('generate_image', { prompt: 'a glass card' })
          : call('respond_to_user', { character_expression: { content: 'Look at this.' } });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(reply),
      });
    };
    await page.route('**/api/llm-proxy', fulfill);
    await page.route('http://llm.test/**', fulfill);

    await page.locator('[data-testid="chat-input"]').fill('Show me the card');
    await page.locator('[data-testid="send-btn"]').click();
    const image = page.locator('[data-testid="generated-image"]').last();
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
    expect(cfTargets).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/acc42/ai/run/@cf/black-forest-labs/flux-1-schnell',
    ]);
  });

  test('the character generates an image and it is shown in chat', async ({ page }) => {
    await mockLLM(page);
    await page.route('**/api/llm-config', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ llm, imageGen: pollinations }),
      }),
    );
    const imageRequests: string[] = [];
    await page.route('https://image.pollinations.ai/**', (route) => {
      imageRequests.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    });

    // LLM: offers generate_image, calls it, then replies, then ends the turn.
    let toolsOffered: string[] = [];
    const toolCall = (name: string, args: unknown) => ({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `call_${name}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    });
    const fulfill = (route: import('@playwright/test').Route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204 });
      const body = route.request().postDataJSON() as {
        messages: Array<{ role: string; tool_call_id?: string }>;
        tools?: Array<{ function: { name: string } }>;
      };
      toolsOffered = (body.tools ?? []).map((t) => t.function.name);
      const last = body.messages.at(-1);
      const reply =
        last?.role !== 'tool'
          ? toolCall('generate_image', { prompt: 'a starship at dawn' })
          : last.tool_call_id === 'call_generate_image'
            ? toolCall('respond_to_user', {
                character_expression: { content: 'Here is our ship.', emotion: 'happy' },
                user_interaction: { suggested_replies: ['Beautiful'] },
              })
            : { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(reply),
      });
    };
    await page.unroute('**/api/llm-proxy');
    await page.unroute('http://llm.test/**');
    await page.route('**/api/llm-proxy', fulfill);
    await page.route('http://llm.test/**', fulfill);

    await page.goto('/');
    await page.locator('[data-testid="chat-input"]').fill('Show me the ship');
    await page.locator('[data-testid="send-btn"]').click();

    const image = page.locator('[data-testid="generated-image"]').last();
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(page.locator('[data-testid="chat-messages"]')).toContainText('Here is our ship.');
    expect(toolsOffered).toContain('generate_image');
    expect(imageRequests).toHaveLength(1);
    expect(imageRequests[0]).toContain('/prompt/a%20starship%20at%20dawn?');
  });
});

test.describe('Shell – live wallpaper', () => {
  for (const mobile of [false, true]) {
    test(`the video toggle opens and closes the live wallpaper${mobile ? ' (phone)' : ''}`, async ({
      browser,
    }) => {
      const context = await browser.newContext(
        mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {},
      );
      const page = await context.newPage();
      // Keep the test offline: an empty video is enough to show the window
      await page.route('https://cdn.openroom.ai/**/*.mp4', (route) =>
        route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }),
      );
      await page.goto('/');
      const toggle = page.locator('[data-testid="wallpaper-toggle"]');
      const pip = page.locator('[data-testid="video-pip"]');
      await expect(toggle).toHaveAttribute('title', 'Live wallpaper: OFF');
      await expect(pip).toHaveCount(0);

      await toggle.click();
      await expect(toggle).toHaveAttribute('title', 'Live wallpaper: ON');
      await expect(pip).toBeVisible();
      await expect(pip.locator('video')).toHaveAttribute('src', /\.mp4$/);
      // The window opens fully on screen
      const box = (await pip.boundingBox())!;
      const size = page.viewportSize()!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);

      // Its own close button, and the toggle, both turn it off
      await pip.locator('button[title="Close"]').click();
      await expect(pip).toHaveCount(0);
      await expect(toggle).toHaveAttribute('title', 'Live wallpaper: OFF');
      await toggle.click();
      await expect(pip).toBeVisible();
      await toggle.click();
      await expect(pip).toHaveCount(0);
      await context.close();
    });
  }
});

/**
 * Stand-in for the browser's speech recognition: the test decides what is
 * "heard" via window.__speech.
 */
async function fakeSpeechRecognition(page: Page) {
  await page.addInitScript(() => {
    type Handler = ((e: unknown) => void) | null;
    const w = window as unknown as Record<string, unknown>;
    const speech = {
      starts: 0,
      lang: '',
      active: null as null | {
        onresult: Handler;
        onerror: Handler;
        onend: (() => void) | null;
      },
      hear(text: string) {
        const results = [Object.assign([{ transcript: text }], { isFinal: false })];
        speech.active?.onresult?.({ resultIndex: 0, results });
      },
      pause() {
        const rec = speech.active;
        speech.active = null;
        rec?.onend?.();
      },
      fail(error: string) {
        const rec = speech.active;
        speech.active = null;
        rec?.onerror?.({ error });
        rec?.onend?.();
      },
    };
    class FakeRecognition {
      lang = '';
      continuous = true;
      interimResults = false;
      maxAlternatives = 1;
      onresult: Handler = null;
      onerror: Handler = null;
      onend: (() => void) | null = null;
      start() {
        speech.starts++;
        speech.lang = this.lang;
        speech.active = this;
      }
      stop() {
        if (speech.active === this) speech.pause();
      }
      abort() {
        if (speech.active === this) speech.fail('aborted');
      }
    }
    w.__speech = speech;
    for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
      Object.defineProperty(window, name, { value: FakeRecognition, configurable: true });
    }
  });
}

type SpeechControl = {
  starts: number;
  lang: string;
  hear(text: string): void;
  pause(): void;
  fail(error: string): void;
};
const speech = <T>(page: Page, fn: (s: SpeechControl) => T) =>
  page.evaluate(
    (src) =>
      new Function('s', `return (${src})(s)`)(
        (window as unknown as { __speech: SpeechControl }).__speech,
      ),
    fn.toString(),
  ) as Promise<T>;

test.describe('Chat panel – voice input', () => {
  test('speaking a message fills the box while talking and sends it on a pause', async ({
    page,
  }) => {
    await fakeSpeechRecognition(page);
    await mockCharacterReply(page, '(laughs) I heard you loud and clear!', ['Nice']);
    await page.goto('/');
    const mic = page.locator('[data-testid="mic-btn"]');
    const input = page.locator('[data-testid="chat-input"]');
    await expect(mic).toBeVisible();
    await expect(mic).toHaveAttribute('aria-pressed', 'false');

    await mic.click();
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect(input).toHaveAttribute('placeholder', 'Listening...');
    expect(await speech(page, (s) => s.lang)).toBe('en-US');

    await speech(page, (s) => s.hear('Can you hear'));
    await expect(input).toHaveValue('Can you hear');
    await speech(page, (s) => s.hear('Can you hear me'));
    await expect(input).toHaveValue('Can you hear me');
    await speech(page, (s) => s.pause());

    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    const messages = page.locator('[data-testid="chat-message"]');
    await expect(messages.filter({ hasText: 'Can you hear me' })).toHaveCount(1);
    await expect(page.locator('[data-testid="chat-messages"]')).toContainText(
      'I heard you loud and clear!',
    );
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('placeholder', 'Type a message...');
  });

  test('tapping the mic again stops listening and sends what was heard', async ({ page }) => {
    await fakeSpeechRecognition(page);
    await mockCharacterReply(page, 'Got it.', []);
    await page.goto('/');
    const mic = page.locator('[data-testid="mic-btn"]');
    await mic.click();
    await speech(page, (s) => s.hear('open the music player'));
    await mic.click();
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    await expect(
      page.locator('[data-testid="chat-message"]').filter({ hasText: 'open the music player' }),
    ).toHaveCount(1);
    await expect(page.locator('[data-testid="chat-messages"]')).toContainText('Got it.');
  });

  test('explains when the microphone is refused or nothing was heard', async ({ page }) => {
    await fakeSpeechRecognition(page);
    await mockCharacterReply(page, 'unused', []);
    await page.goto('/');
    const mic = page.locator('[data-testid="mic-btn"]');
    const note = page.locator('[data-testid="voice-note"]');
    const messages = page.locator('[data-testid="chat-message"]');
    await expect(messages.first()).toBeVisible();
    const before = await messages.count();

    await mic.click();
    await speech(page, (s) => s.fail('not-allowed'));
    await expect(note).toContainText('Microphone access was refused');
    await expect(mic).toHaveAttribute('aria-pressed', 'false');

    // Trying again hides the old note; silence gets its own hint and sends nothing
    await mic.click();
    await expect(note).toHaveCount(0);
    await speech(page, (s) => s.fail('no-speech'));
    await expect(note).toContainText("I didn't catch that");
    expect(await speech(page, (s) => s.starts)).toBe(2);
    await expect(messages).toHaveCount(before);
  });

  test('the mic button is hidden when the browser has no speech recognition', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
      delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    });
    await mockLLM(page);
    await page.goto('/');
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="mic-btn"]')).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('the mic sits next to the input, uncovered, and works by tap', async ({ page }) => {
      await fakeSpeechRecognition(page);
      await mockCharacterReply(page, 'Hello from your phone!', []);
      await page.goto('/');
      const mic = page.locator('[data-testid="mic-btn"]');
      const send = page.locator('[data-testid="send-btn"]');
      const micBox = (await mic.boundingBox())!;
      const sendBox = (await send.boundingBox())!;
      expect(micBox.x + micBox.width).toBeLessThanOrEqual(sendBox.x);
      // Nothing else is on top of the mic button
      const hit = await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="mic-btn"]') !== null,
        [micBox.x + micBox.width / 2, micBox.y + micBox.height / 2],
      );
      expect(hit).toBe(true);

      await mic.tap();
      await speech(page, (s) => s.hear('hi there'));
      await speech(page, (s) => s.pause());
      await expect(page.locator('[data-testid="chat-messages"]')).toContainText(
        'Hello from your phone!',
      );
    });
  });
});
