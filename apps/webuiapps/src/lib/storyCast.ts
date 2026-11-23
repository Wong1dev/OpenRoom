/**
 * Story cast — the characters of a story and what they remember.
 *
 * A story (mod) can have a cast. One cast member is the "speaker": the one the
 * user is talking to right now. The speaker can change mid-story, either because
 * the story hands the scene over (switch_speaker tool) or because the user taps
 * another cast member.
 *
 * A cast member is either linked to an existing OpenRoom character
 * (`character_id`: persona and mood videos come from that character) or exists
 * only in this story (persona and an optional generated portrait).
 *
 * Per-member memory (attitude towards the user, what they know, notes) and the
 * player's key choices live in the mod's state and are saved with it.
 */
import type { CharacterConfig } from './characterManager';

export interface CastMember {
  id: string;
  name: string;
  gender: string;
  /** Their part in this story, e.g. "barmaid at the Gilded Heron" */
  role: string;
  /** Personality, look and manner (for story-only members: their full persona) */
  persona: string;
  /** What they hide; only shown to the model while this member is speaking */
  secret?: string;
  /** Links an existing OpenRoom character (uses its persona and videos) */
  character_id?: string;
  /** Portrait for story-only members */
  portrait_url?: string;
  /** Image prompt used to generate the portrait */
  portrait_prompt?: string;
}

export interface CastMemberState {
  /** How they currently feel about the user, in a few words */
  attitude?: string;
  /** Things they have learned during the story */
  knows: string[];
  /** Notable things they did or that happened to them */
  notes: string[];
  /** Has met the user / appeared in the story */
  introduced?: boolean;
}

/** The cast-related part of a mod's state (all optional for older states). */
export interface CastStateFields {
  speaker_id?: string;
  cast_state?: Record<string, CastMemberState>;
  plot_log?: string[];
}

export interface CastUpdate {
  cast_id: string;
  attitude?: string;
  learned?: string;
  note?: string;
}

export const MAX_MEMBER_ENTRIES = 12;
export const MAX_PLOT_LOG = 30;
/** Number of recent player choices shown to the model. */
export const PROMPT_PLOT_CHOICES = 10;
/** Prefix for CharacterConfig ids of story-only members (keeps them apart from real characters). */
export const CAST_CHARACTER_PREFIX = 'cast:';

function pushCapped(list: string[], item: string, cap: number): string[] {
  const next = [...list, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function emptyMemberState(): CastMemberState {
  return { knows: [], notes: [] };
}

export function findCastMember(cast: CastMember[], id: string): CastMember | undefined {
  return cast.find((m) => m.id === id);
}

/** Lead of the story: `lead_id` if it is in the cast, else the first member. */
export function getLeadId(cast: CastMember[], leadId?: string): string | null {
  if (leadId && findCastMember(cast, leadId)) return leadId;
  return cast[0]?.id ?? null;
}

/** Current speaker: the saved speaker if still in the cast, else the lead. */
export function getSpeakerId(
  cast: CastMember[],
  state: CastStateFields,
  leadId?: string,
): string | null {
  if (state.speaker_id && findCastMember(cast, state.speaker_id)) return state.speaker_id;
  return getLeadId(cast, leadId);
}

export function getMemberState(state: CastStateFields, id: string): CastMemberState {
  return state.cast_state?.[id] ?? emptyMemberState();
}

/** Whether a member should be shown to the user (met, speaking, or the lead). */
export function isIntroduced(
  cast: CastMember[],
  state: CastStateFields,
  id: string,
  leadId?: string,
): boolean {
  if (id === getLeadId(cast, leadId)) return true;
  if (id === state.speaker_id) return true;
  return !!state.cast_state?.[id]?.introduced;
}

function withMember<T extends CastStateFields>(
  state: T,
  id: string,
  change: (m: CastMemberState) => CastMemberState,
): T {
  const current = getMemberState(state, id);
  return { ...state, cast_state: { ...(state.cast_state ?? {}), [id]: change(current) } };
}

/** Make `id` the speaker (and mark them as introduced). */
export function setSpeakerState<T extends CastStateFields>(state: T, id: string): T {
  return { ...withMember(state, id, (m) => ({ ...m, introduced: true })), speaker_id: id };
}

/** Apply a memory update for one member. Empty fields are ignored. */
export function applyCastUpdate<T extends CastStateFields>(state: T, update: CastUpdate): T {
  const attitude = update.attitude?.trim();
  const learned = update.learned?.trim();
  const note = update.note?.trim();
  return withMember(state, update.cast_id, (m) => ({
    ...m,
    introduced: true,
    attitude: attitude || m.attitude,
    knows: learned ? pushCapped(m.knows, learned, MAX_MEMBER_ENTRIES) : m.knows,
    notes: note ? pushCapped(m.notes, note, MAX_MEMBER_ENTRIES) : m.notes,
  }));
}

/** Log a key player choice (keeps the last MAX_PLOT_LOG). */
export function logPlotChoice<T extends CastStateFields>(state: T, summary: string): T {
  const text = summary.trim();
  if (!text) return state;
  return { ...state, plot_log: pushCapped(state.plot_log ?? [], text, MAX_PLOT_LOG) };
}

/**
 * The CharacterConfig to speak and show as. Linked members use the real
 * character; story-only members (or links to a deleted character) get a
 * config built from their persona and portrait.
 */
export function castMemberToCharacter(
  member: CastMember,
  characters: Record<string, CharacterConfig>,
): CharacterConfig {
  const linked = member.character_id ? characters[member.character_id] : undefined;
  if (linked) return linked;
  return {
    id: `${CAST_CHARACTER_PREFIX}${member.id}`,
    character_name: member.name,
    character_gender_desc: member.gender || 'unspecified',
    character_desc: `Your part in this story: ${member.role}.\n${member.persona}`,
    character_emotion_list: ['default', 'happy', 'shy', 'peaceful', 'depressing', 'angry'],
    character_meta_info: member.portrait_url ? { base_image_url: member.portrait_url } : undefined,
  };
}

function describeMemory(m: CastMemberState): string {
  const parts: string[] = [];
  if (m.attitude) parts.push(`Feels about the user: ${m.attitude}.`);
  if (m.knows.length) parts.push(`Knows: ${m.knows.join('; ')}.`);
  if (m.notes.length) parts.push(`Notes: ${m.notes.join('; ')}.`);
  return parts.join(' ');
}

/** Prompt section describing the cast, the speaker's own memory and the player's choices. */
export function buildCastPrompt(
  cast: CastMember[],
  state: CastStateFields,
  leadId?: string,
): string {
  const speakerId = getSpeakerId(cast, state, leadId);
  const speaker = speakerId ? findCastMember(cast, speakerId) : undefined;
  if (!speaker) return '';

  const own = getMemberState(state, speaker.id);
  let out = `\n[Story Cast]\nYou are speaking as ${speaker.name} (${speaker.role}).\n`;
  if (speaker.character_id) out += `In this story: ${speaker.persona}\n`;
  if (speaker.secret) {
    out += `Your secret in this story (reveal it only when the story calls for it): ${speaker.secret}\n`;
  }
  const ownMemory = describeMemory(own);
  if (ownMemory) out += `Your memory so far: ${ownMemory}\n`;

  const others = cast.filter((m) => m.id !== speaker.id);
  if (others.length) {
    out += '\nOther cast members (not speaking now):\n';
    for (const m of others) {
      const ms = getMemberState(state, m.id);
      const met = isIntroduced(cast, state, m.id, leadId) ? '' : ' Has not met the user yet.';
      const memory = describeMemory(ms);
      out += `- [${m.id}] ${m.name}: ${m.role}.${met}${memory ? ' ' + memory : ''}\n`;
    }
  }

  const choices = (state.plot_log ?? []).slice(-PROMPT_PLOT_CHOICES);
  if (choices.length) {
    out += "\nThe player's key choices so far (the story must respect them):\n";
    out += choices.map((c) => `- ${c}`).join('\n') + '\n';
  }

  out +=
    `\nCast rules:\n` +
    `- Speak only as ${speaker.name}. Never write another cast member's spoken lines. ` +
    `If someone else should take over the conversation, call switch_speaker with their id; ` +
    `they will answer next.\n` +
    `- When a cast member appears in the scene for the first time, or their feelings about the user ` +
    `or what they know changes, call update_cast for them.\n` +
    `- When the user makes a decision that matters for the plot, call record_choice with a one-line summary.\n` +
    `- These calls are silent: never mention them to the user.\n`;
  return out;
}
