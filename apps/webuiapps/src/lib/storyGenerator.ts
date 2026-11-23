/**
 * Story generator — writes a new story (mod with a cast) from the chosen
 * characters and the player's premise, and revises upcoming stages so the plot
 * follows the player's choices.
 *
 * The model is asked for a small JSON document, which is validated and turned
 * into a ModConfig. An invalid answer is retried once with the problems listed.
 */
import type { CharacterConfig } from './characterManager';
import { chat, type ChatMessage } from './llmClient';
import type { LLMConfig } from './llmModels';
import {
  generateModId,
  type ModConfig,
  type ModEntry,
  type ModState,
  type Stage,
} from './modManager';
import type { CastMember } from './storyCast';

export type ChatFn = typeof chat;

export interface StoryRequest {
  /** OpenRoom characters to include; the first one leads the story. */
  characters: CharacterConfig[];
  /** The player's premise and wishes (may be empty). */
  premise?: string;
  stageCount: number;
  /** Continue from this story (sequel). */
  sequelOf?: ModEntry;
}

/** The JSON shape the model is asked to produce. */
interface StoryDraft {
  title?: unknown;
  setting?: unknown;
  display_desc?: unknown;
  prologue?: unknown;
  opening_replies?: unknown;
  lead_id?: unknown;
  cast?: unknown;
  stages?: unknown;
}

export const MIN_STAGES = 3;
export const MAX_STAGES = 6;
export const MAX_CAST = 8;
const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/** Parse the first JSON object in a model answer (tolerates code fences and chatter). */
export function extractJson(text: string | null | undefined): unknown {
  if (!text) throw new Error('empty answer');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(body.slice(start, end + 1));
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// ---------------------------------------------------------------------------
// New story
// ---------------------------------------------------------------------------

const OS_RULES =
  '## The OS\n' +
  "You can reach into the user's device (their OS) from inside the story: change the wallpaper, play music, " +
  'write in the Diary, post on Twitter, send Email and add pictures to the Album. Give this a fitting ' +
  'in-world explanation from the setting and use it to make the story tangible, at most one app per turn.\n\n' +
  '## Important\n' +
  '- Stay inside this setting. Keep each character consistent with their description.\n' +
  '- To show the user a picture, call the generate_image tool (and SET_WALLPAPER with its result for a ' +
  'backdrop). Never write "(generates image)" or describe an image you did not generate.\n' +
  '- Proceed gradually with short, lively replies, and let the user make the choices that matter. Their ' +
  'choices genuinely change what happens.';

function describeCharacter(c: CharacterConfig): string {
  return `### ${c.character_name} (character_id: "${c.id}", ${c.character_gender_desc})\n${c.character_desc.slice(0, 2500)}`;
}

function describeSequel(entry: ModEntry): string {
  const cfg = entry.config;
  const st = entry.state;
  const cast = (cfg.cast ?? [])
    .map((m) => {
      const ms = st.cast_state?.[m.id];
      const mem = ms
        ? ` Feels: ${ms.attitude ?? 'unknown'}. Knows: ${ms.knows.join('; ') || '-'}. Notes: ${ms.notes.join('; ') || '-'}.`
        : '';
      return `- [${m.id}] ${m.name}, ${m.role}${m.character_id ? ` (character_id "${m.character_id}")` : ''}.${mem}`;
    })
    .join('\n');
  const stages = Object.values(cfg.stages)
    .sort((a, b) => a.stage_index - b.stage_index)
    .map((s) => `- ${s.stage_name}: ${s.stage_description.slice(0, 400)}`)
    .join('\n');
  return (
    `\n## Previous story (write a sequel that continues it)\n` +
    `Title: ${cfg.mod_name_en || cfg.mod_name}\n${cfg.mod_description.slice(0, 2500)}\n\nStages:\n${stages}\n` +
    (cast ? `\nCast at the end:\n${cast}\n` : '') +
    (st.plot_log?.length
      ? `\nThe player's choices:\n${st.plot_log.map((c) => `- ${c}`).join('\n')}\n`
      : '') +
    "Keep what happened and the cast members' memories; returning cast members keep their ids.\n"
  );
}

export function buildStoryMessages(req: StoryRequest): ChatMessage[] {
  const n = req.stageCount;
  const system =
    'You design interactive role-play stories for OpenRoom, where the user chats with characters who can ' +
    "also act on the user's device. Answer with ONE JSON object and nothing else, in this shape:\n" +
    '{\n' +
    '  "title": "short story title",\n' +
    '  "setting": "2-4 paragraphs for the role-playing model: world, place, situation, the central mystery or conflict, and the hidden truth behind it",\n' +
    '  "display_desc": "a spoiler-free blurb for the player (3-4 sentences), ending with \\"Genre: ...\\"",\n' +
    '  "prologue": "the lead\'s first line to the user, with an action in parentheses",\n' +
    '  "opening_replies": ["three short replies for the user, under 25 characters each"],\n' +
    '  "lead_id": "cast id of the lead",\n' +
    '  "cast": [{"id": "lowercase_snake_id", "name": "...", "gender": "...", "role": "their part in this story", "persona": "personality, look and manner, 2-4 sentences", "secret": "what they hide (optional)", "character_id": "only for the given OpenRoom characters", "portrait_prompt": "image prompt for a portrait, only for new characters"}],\n' +
    `  "stages": [{"name": "...", "description": "what happens in this stage and which apps can be used, written as instructions to the role-playing model", "targets": ["1-3 concrete goals that end the stage"]}]\n` +
    '}\n' +
    'Rules:\n' +
    `- Exactly ${n} stages. The last stage resolves the central conflict and reveals the truth.\n` +
    '- Every given OpenRoom character must be in the cast with its character_id; the first one is the lead. ' +
    'Their persona field says what they are doing in this story.\n' +
    `- Add 2-5 new supporting characters with distinct voices, motives and secrets (at most ${MAX_CAST} cast members in total). ` +
    'The story should hand the conversation to them at key moments, so give them real reasons to talk to the user.\n' +
    "- Stage targets depend on the user's involvement, and leave room for the user's choices to change the outcome.\n" +
    '- Never reveal secrets or the hidden truth in display_desc or the prologue.\n' +
    '- Write in English.';

  let user =
    '## OpenRoom characters in this story\n' + req.characters.map(describeCharacter).join('\n\n');
  if (req.sequelOf) user += '\n' + describeSequel(req.sequelOf);
  user += `\n\n## The player's wishes\n${req.premise?.trim() || '(none: surprise them, in a setting that suits the lead character)'}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'c_$1')
    .slice(0, 32);
  return s || 'member';
}

/** Validate a draft and convert it to a ModConfig. Returns problems instead when invalid. */
export function draftToConfig(
  raw: unknown,
  req: StoryRequest,
  id: string,
): { config: ModConfig } | { errors: string[] } {
  const errors: string[] = [];
  const d = (raw && typeof raw === 'object' ? raw : {}) as StoryDraft;

  const title = str(d.title);
  const setting = str(d.setting);
  const displayDesc = str(d.display_desc);
  const prologue = str(d.prologue);
  if (!title) errors.push('"title" is missing');
  if (!setting) errors.push('"setting" is missing');
  if (!prologue) errors.push('"prologue" is missing');

  // Cast
  const known = new Map(req.characters.map((c) => [c.id, c]));
  const cast: CastMember[] = [];
  const rawCast = Array.isArray(d.cast) ? d.cast : [];
  if (rawCast.length === 0) errors.push('"cast" must list the characters');
  if (rawCast.length > MAX_CAST) errors.push(`"cast" has more than ${MAX_CAST} members`);
  const idMap = new Map<string, string>(); // model id -> final id
  for (const item of rawCast.slice(0, MAX_CAST)) {
    const m = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const name = str(m.name);
    if (!name) {
      errors.push('a cast member has no "name"');
      continue;
    }
    const rawId = str(m.id);
    let memberId = ID_RE.test(rawId) ? rawId : slugify(rawId || name);
    while (cast.some((c) => c.id === memberId)) memberId = `${memberId}_2`;
    if (rawId) idMap.set(rawId, memberId);
    const characterId = str(m.character_id);
    if (characterId && !known.has(characterId)) {
      errors.push(`cast member "${name}" has unknown character_id "${characterId}"`);
    }
    const linked = characterId ? known.get(characterId) : undefined;
    const member: CastMember = {
      id: memberId,
      name: linked?.character_name ?? name,
      gender: str(m.gender) || linked?.character_gender_desc || 'unspecified',
      role: str(m.role) || 'a character in this story',
      persona: str(m.persona),
    };
    if (!member.persona && !linked) errors.push(`cast member "${name}" has no "persona"`);
    const secret = str(m.secret);
    if (secret) member.secret = secret;
    if (linked) member.character_id = linked.id;
    const portrait = str(m.portrait_prompt);
    if (portrait && !linked) member.portrait_prompt = portrait;
    cast.push(member);
  }
  for (const c of req.characters) {
    if (!cast.some((m) => m.character_id === c.id)) {
      errors.push(`"${c.character_name}" (character_id "${c.id}") must be in the cast`);
    }
  }
  for (const m of cast) {
    if (m.secret && m.secret.length >= 12 && displayDesc.includes(m.secret)) {
      errors.push(`display_desc reveals ${m.name}'s secret`);
    }
  }

  // Stages
  const rawStages = Array.isArray(d.stages) ? d.stages : [];
  if (rawStages.length !== req.stageCount) {
    errors.push(`there must be exactly ${req.stageCount} stages (got ${rawStages.length})`);
  }
  const stages: Record<number, Stage> = {};
  let targetId = 1;
  rawStages.forEach((item, i) => {
    const s = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const name = str(s.name) || `Stage ${i + 1}`;
    const description = str(s.description);
    if (!description) errors.push(`stage ${i + 1} has no "description"`);
    const targets = (Array.isArray(s.targets) ? s.targets : []).map(str).filter(Boolean);
    if (targets.length === 0) errors.push(`stage ${i + 1} has no "targets"`);
    const stageTargets: Record<number, string> = {};
    for (const t of targets.slice(0, 4)) stageTargets[targetId++] = t;
    stages[i] = {
      stage_index: i,
      stage_name: name,
      stage_description: description,
      stage_targets: stageTargets,
    };
  });

  if (errors.length) return { errors };

  const rawLead = str(d.lead_id);
  const leadCharacter = req.characters[0];
  const lead =
    cast.find((m) => leadCharacter && m.character_id === leadCharacter.id)?.id ??
    idMap.get(rawLead) ??
    cast[0].id;

  const replies = (Array.isArray(d.opening_replies) ? d.opening_replies : [])
    .map(str)
    .filter(Boolean)
    .slice(0, 3)
    .map((reply_text) => ({ reply_text }));

  return {
    config: {
      id,
      mod_name: title,
      mod_name_en: title,
      mod_description:
        'You are role-playing a narrative script. Follow this story framework and advance the interaction ' +
        'by controlling a virtual OS according to the current stage of the plot.\n\n' +
        `## Setting\n${setting}\n\n${OS_RULES}`,
      stage_count: rawStages.length,
      stages,
      display_desc: displayDesc || undefined,
      prologue,
      opening_rec_replies: replies.length ? replies : undefined,
      cast,
      lead_id: lead,
    },
  };
}

/** Ask the model for a new story. Throws with the remaining problems if it fails twice. */
export async function generateStory(
  req: StoryRequest,
  llm: LLMConfig,
  chatFn: ChatFn = chat,
): Promise<ModConfig> {
  if (req.characters.length === 0) throw new Error('Choose at least one character.');
  const stageCount = Math.min(MAX_STAGES, Math.max(MIN_STAGES, Math.round(req.stageCount)));
  const request = { ...req, stageCount };
  const id = generateModId();
  const messages = buildStoryMessages(request);
  let problems: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await chatFn(messages, [], llm);
    let parsed: unknown;
    try {
      parsed = extractJson(response.content);
    } catch (err) {
      problems = [`the answer was not valid JSON (${(err as Error).message})`];
    }
    if (parsed !== undefined) {
      const result = draftToConfig(parsed, request, id);
      if ('config' in result) return result.config;
      problems = result.errors;
    }
    messages.push(
      { role: 'assistant', content: response.content ?? '' },
      {
        role: 'user',
        content: `That doesn't work yet: ${problems.join('; ')}. Answer again with the complete, corrected JSON object only.`,
      },
    );
  }
  throw new Error(`The model could not write a valid story: ${problems.join('; ')}`);
}

// ---------------------------------------------------------------------------
// Adaptive stages
// ---------------------------------------------------------------------------

export function buildReviseMessages(config: ModConfig, state: ModState): ChatMessage[] | null {
  const next = config.stages[state.current_stage_index];
  if (!next || state.is_finished || !config.cast?.length) return null;
  const previous = Object.values(config.stages)
    .filter((s) => s.stage_index < next.stage_index)
    .sort((a, b) => a.stage_index - b.stage_index)
    .map((s) => `- ${s.stage_name}: ${s.stage_description.slice(0, 500)}`)
    .join('\n');
  const cast = config.cast
    .map((m) => {
      const ms = state.cast_state?.[m.id];
      return `- [${m.id}] ${m.name}, ${m.role}. Feels: ${ms?.attitude ?? 'unknown'}. Knows: ${ms?.knows.join('; ') || '-'}. Notes: ${ms?.notes.join('; ') || '-'}.`;
    })
    .join('\n');
  const targets = Object.entries(next.stage_targets)
    .map(([id, t]) => `  "${id}": ${JSON.stringify(t)}`)
    .join(',\n');
  return [
    {
      role: 'system',
      content:
        'You adapt the next stage of an interactive story so it follows what the player actually did. ' +
        "Keep the stage's purpose and the overall arc, but weave in the player's choices and the cast's " +
        "changed feelings and knowledge; drop anything the player's choices made impossible. " +
        'Answer with ONE JSON object only: {"description": "...", "targets": {"<same ids>": "..."}} using exactly the same target ids.',
    },
    {
      role: 'user',
      content:
        `Story: ${config.mod_name_en || config.mod_name}\n${config.mod_description.slice(0, 2000)}\n\n` +
        `Stages played so far:\n${previous || '-'}\n\n` +
        `The player's choices:\n${(state.plot_log ?? []).map((c) => `- ${c}`).join('\n') || '- (none recorded)'}\n\n` +
        `Cast now:\n${cast}\n\n` +
        `Next stage to adapt: ${next.stage_name}\nDescription: ${next.stage_description}\nTargets: {\n${targets}\n}`,
    },
  ];
}

/**
 * Rewrite the current (just reached) stage from the player's choices and the
 * cast's memory. Returns the updated config, or null when there is nothing to
 * revise or the answer was unusable (the original stage then stays).
 */
export async function reviseNextStage(
  config: ModConfig,
  state: ModState,
  llm: LLMConfig,
  chatFn: ChatFn = chat,
): Promise<ModConfig | null> {
  const messages = buildReviseMessages(config, state);
  if (!messages) return null;
  const next = config.stages[state.current_stage_index];
  try {
    const response = await chatFn(messages, [], llm);
    const parsed = extractJson(response.content) as { description?: unknown; targets?: unknown };
    const description = str(parsed.description);
    const targets = (
      parsed.targets && typeof parsed.targets === 'object' ? parsed.targets : {}
    ) as Record<string, unknown>;
    const ids = Object.keys(next.stage_targets);
    if (!description || !ids.every((id) => str(targets[id]))) return null;
    const stageTargets: Record<number, string> = {};
    for (const id of ids) stageTargets[Number(id)] = str(targets[id]);
    return {
      ...config,
      stages: {
        ...config.stages,
        [next.stage_index]: {
          ...next,
          stage_description: description,
          stage_targets: stageTargets,
        },
      },
    };
  } catch {
    return null;
  }
}
