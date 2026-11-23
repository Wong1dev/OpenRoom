import { describe, expect, it } from 'vitest';
import { createChatSessionGuard } from '../chatSessionGuard';

describe('createChatSessionGuard', () => {
  it('allows no save before the first history load', () => {
    const g = createChatSessionGuard('aoi/space');
    expect(g.isCurrent('aoi/space')).toBe(true);
    expect(g.saveTarget()).toBeNull();
  });

  it('saves to the session whose history was loaded', () => {
    const g = createChatSessionGuard('aoi/space');
    g.loaded('aoi/space');
    expect(g.saveTarget()).toBe('aoi/space');
  });

  it('drops a load that resolves after the session switched (late load)', () => {
    const g = createChatSessionGuard('aoi/space');
    g.switchTo('kestrel/space');
    // Aoi's history arrives late: it must not be applied or saved under Kestrel.
    expect(g.isCurrent('aoi/space')).toBe(false);
    g.loaded('aoi/space');
    expect(g.saveTarget()).toBeNull();
    // Kestrel's own history arrives: now saves go to Kestrel.
    expect(g.isCurrent('kestrel/space')).toBe(true);
    g.loaded('kestrel/space');
    expect(g.saveTarget()).toBe('kestrel/space');
  });

  it('blocks a pending save of the old chat after a switch (pending save)', () => {
    const g = createChatSessionGuard('aoi/space');
    g.loaded('aoi/space');
    g.switchTo('kestrel/space');
    // The debounced save for Aoi's messages fires now: nowhere to write.
    expect(g.saveTarget()).toBeNull();
  });

  it('keeps ownership when the same session is re-selected (e.g. mod state reload)', () => {
    const g = createChatSessionGuard('kestrel/space');
    g.loaded('kestrel/space');
    g.switchTo('kestrel/space');
    expect(g.saveTarget()).toBe('kestrel/space');
  });

  it('handles switching back to a previous session', () => {
    const g = createChatSessionGuard('aoi/space');
    g.loaded('aoi/space');
    g.switchTo('kestrel/space');
    g.switchTo('aoi/space');
    expect(g.saveTarget()).toBeNull();
    expect(g.isCurrent('aoi/space')).toBe(true);
    g.loaded('aoi/space');
    expect(g.saveTarget()).toBe('aoi/space');
  });
});
