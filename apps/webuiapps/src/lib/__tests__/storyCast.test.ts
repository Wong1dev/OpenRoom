import { describe, expect, it } from 'vitest';
import type { CharacterConfig } from '../characterManager';
import { ModManager, type ModConfig } from '../modManager';
import {
  applyCastUpdate,
  buildCastPrompt,
  castMemberToCharacter,
  getLeadId,
  getMemberState,
  getSpeakerId,
  isIntroduced,
  logPlotChoice,
  MAX_MEMBER_ENTRIES,
  MAX_PLOT_LOG,
  setSpeakerState,
  type CastMember,
} from '../storyCast';

const kestrel: CharacterConfig = {
  id: 'kestrel',
  character_name: 'Kestrel Vane',
  character_gender_desc: 'Female',
  character_desc: 'A half-elf card sharp.',
  character_emotion_list: ['default', 'happy'],
  character_meta_info: { emotion_videos: { default: ['/k.mp4'] } },
};

const cast: CastMember[] = [
  {
    id: 'kestrel',
    name: 'Kestrel Vane',
    gender: 'Female',
    role: 'card sharp',
    persona: 'Counting her winnings at the Heron.',
    secret: 'She was raised by the Lantern Troupe.',
    character_id: 'kestrel',
  },
  {
    id: 'pell',
    name: 'Pell',
    gender: 'Female',
    role: 'barmaid at the Gilded Heron',
    persona: 'Sharp-eyed and dry.',
    secret: 'She saw the collector palm the card.',
    portrait_prompt: 'young barmaid, freckles',
  },
  { id: 'osric', name: 'Osric Fenn', gender: 'Male', role: 'barge captain', persona: 'Loud.' },
];

describe('speaker and lead', () => {
  it('defaults to the lead, then the first member', () => {
    expect(getLeadId(cast, 'pell')).toBe('pell');
    expect(getLeadId(cast, 'nobody')).toBe('kestrel');
    expect(getLeadId([], undefined)).toBeNull();
    expect(getSpeakerId(cast, {}, 'pell')).toBe('pell');
    expect(getSpeakerId(cast, { speaker_id: 'osric' })).toBe('osric');
    expect(getSpeakerId(cast, { speaker_id: 'gone' })).toBe('kestrel');
  });

  it('setSpeakerState switches the speaker and introduces them', () => {
    const st = setSpeakerState({}, 'pell');
    expect(st.speaker_id).toBe('pell');
    expect(st.cast_state?.pell.introduced).toBe(true);
  });

  it('isIntroduced: lead and speaker are always shown, others once met', () => {
    expect(isIntroduced(cast, {}, 'kestrel')).toBe(true);
    expect(isIntroduced(cast, {}, 'pell')).toBe(false);
    expect(isIntroduced(cast, { speaker_id: 'pell' }, 'pell')).toBe(true);
    expect(isIntroduced(cast, applyCastUpdate({}, { cast_id: 'osric' }), 'osric')).toBe(true);
  });
});

describe('memory', () => {
  it('applyCastUpdate records attitude, knowledge and notes, ignoring blanks', () => {
    let st = applyCastUpdate({}, { cast_id: 'pell', attitude: 'curious', learned: 'the card' });
    st = applyCastUpdate(st, { cast_id: 'pell', attitude: '  ', note: 'poured a free cider' });
    const m = getMemberState(st, 'pell');
    expect(m).toEqual({
      introduced: true,
      attitude: 'curious',
      knows: ['the card'],
      notes: ['poured a free cider'],
    });
    expect(getMemberState(st, 'osric')).toEqual({ knows: [], notes: [] });
  });

  it('caps memory entries and the plot log', () => {
    let st = {};
    for (let i = 0; i < MAX_MEMBER_ENTRIES + 3; i++) {
      st = applyCastUpdate(st, { cast_id: 'pell', learned: `fact ${i}` });
    }
    const knows = getMemberState(st, 'pell').knows;
    expect(knows).toHaveLength(MAX_MEMBER_ENTRIES);
    expect(knows[knows.length - 1]).toBe(`fact ${MAX_MEMBER_ENTRIES + 2}`);

    let log = {};
    for (let i = 0; i < MAX_PLOT_LOG + 2; i++) log = logPlotChoice(log, `choice ${i}`);
    expect((log as { plot_log: string[] }).plot_log).toHaveLength(MAX_PLOT_LOG);
    expect(logPlotChoice({}, '   ')).toEqual({});
  });
});

describe('castMemberToCharacter', () => {
  it('uses the linked OpenRoom character', () => {
    expect(castMemberToCharacter(cast[0], { kestrel })).toBe(kestrel);
  });

  it('builds a character for story-only members (and dangling links)', () => {
    const pell = castMemberToCharacter({ ...cast[1], portrait_url: '/p.png' }, {});
    expect(pell.id).toBe('cast:pell');
    expect(pell.character_name).toBe('Pell');
    expect(pell.character_desc).toContain('barmaid at the Gilded Heron');
    expect(pell.character_desc).not.toContain('collector'); // secret stays out
    expect(pell.character_meta_info?.base_image_url).toBe('/p.png');
    const noPortrait = castMemberToCharacter({ ...cast[2], gender: '' }, {});
    expect(noPortrait.character_meta_info).toBeUndefined();
    expect(noPortrait.character_gender_desc).toBe('unspecified');
    expect(castMemberToCharacter(cast[0], {}).id).toBe('cast:kestrel');
  });
});

describe('buildCastPrompt', () => {
  it('describes the speaker with their secret, others without', () => {
    const st = logPlotChoice(
      applyCastUpdate({ speaker_id: 'pell' }, { cast_id: 'osric', attitude: 'wary' }),
      'Kept the card',
    );
    const p = buildCastPrompt(cast, st);
    expect(p).toContain('You are speaking as Pell (barmaid at the Gilded Heron)');
    expect(p).toContain('She saw the collector palm the card.');
    expect(p).not.toContain('Lantern Troupe');
    expect(p).toContain('[osric] Osric Fenn: barge captain. Feels about the user: wary.');
    expect(p).toContain('[kestrel] Kestrel Vane: card sharp.');
    expect(p).toContain('- Kept the card');
    expect(p).toContain('call switch_speaker');
  });

  it('adds the story persona for linked characters and their own memory', () => {
    const st = applyCastUpdate({}, { cast_id: 'kestrel', note: 'won big' });
    const p = buildCastPrompt(cast, st);
    expect(p).toContain('In this story: Counting her winnings');
    expect(p).toContain('Your memory so far: Notes: won big.');
    expect(p).toContain('[pell] Pell: barmaid at the Gilded Heron. Has not met the user yet.');
  });

  it('is empty without a cast', () => {
    expect(buildCastPrompt([], {})).toBe('');
  });
});

describe('ModManager with a cast', () => {
  const config: ModConfig = {
    id: 'tavern',
    mod_name: 'T',
    mod_name_en: 'T',
    mod_description: '',
    stage_count: 1,
    stages: {
      0: { stage_index: 0, stage_name: 'S1', stage_description: 'd', stage_targets: { 1: 't' } },
    },
    cast,
    lead_id: 'kestrel',
  };

  it('tracks the speaker, memory and choices', () => {
    const mm = new ModManager(config);
    expect(mm.hasCast).toBe(true);
    expect(mm.speakerId).toBe('kestrel');
    expect(mm.speaker?.name).toBe('Kestrel Vane');
    expect(mm.setSpeaker('nobody')).toBe(false);
    expect(mm.setSpeaker('pell')).toBe(true);
    expect(mm.speaker?.name).toBe('Pell');
    expect(mm.updateCast({ cast_id: 'nobody' })).toContain('unknown cast_id');
    expect(mm.updateCast({ cast_id: 'osric', attitude: 'friendly' })).toBe('success');
    expect(mm.recordChoice(' ')).toContain('error');
    expect(mm.recordChoice('Trusted Pell')).toBe('success');
    expect(mm.getState().plot_log).toEqual(['Trusted Pell']);
    expect(mm.buildStageReminder()).toContain('You are speaking as Pell');
  });

  it('keeps the cast in free mode and when the stage is missing', () => {
    const mm = new ModManager(config);
    mm.finishTarget([1]);
    expect(mm.isFinished).toBe(true);
    expect(mm.buildStageReminder()).toContain('[Story Complete]');
    expect(mm.buildStageReminder()).toContain('[Story Cast]');
    const broken = new ModManager({ ...config, stages: {} });
    expect(broken.buildStageReminder()).toContain('[Story Cast]');
  });

  it('setConfig replaces the config and keeps the state', () => {
    const mm = new ModManager(config);
    mm.setSpeaker('osric');
    mm.setConfig({ ...config, mod_name_en: 'Renamed' });
    expect(mm.getConfig().mod_name_en).toBe('Renamed');
    expect(mm.speakerId).toBe('osric');
  });

  it('stories without a cast are unchanged', () => {
    const mm = new ModManager({ ...config, cast: undefined });
    expect(mm.hasCast).toBe(false);
    expect(mm.speakerId).toBeNull();
    expect(mm.speaker).toBeNull();
    expect(mm.buildStageReminder()).not.toContain('[Story Cast]');
  });
});
