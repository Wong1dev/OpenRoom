import React, { useState } from 'react';
import { X, Sparkles } from 'lucide-react';
import type { CharacterConfig } from '@/lib/characterManager';
import type { LLMConfig } from '@/lib/llmModels';
import type { ModConfig, ModEntry } from '@/lib/modManager';
import { generateStory, MAX_STAGES, MIN_STAGES, type ChatFn } from '@/lib/storyGenerator';
import styles from './panel.module.scss';

/**
 * "Write a new story": pick the characters, describe what you'd like, and the
 * model writes a story with a cast. Shows a preview before it is added.
 */
const StoryGenerator: React.FC<{
  characters: CharacterConfig[];
  activeCharacterId: string;
  stories: ModEntry[];
  llmConfig: LLMConfig | null;
  onCreate: (config: ModConfig) => void;
  onClose: () => void;
  /** For tests */
  chatFn?: ChatFn;
}> = ({ characters, activeCharacterId, stories, llmConfig, onCreate, onClose, chatFn }) => {
  const [selected, setSelected] = useState<string[]>(() =>
    characters.some((c) => c.id === activeCharacterId) ? [activeCharacterId] : [],
  );
  const [premise, setPremise] = useState('');
  const [stageCount, setStageCount] = useState(4);
  const [sequelOf, setSequelOf] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModConfig | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleGenerate = async () => {
    if (!llmConfig) {
      setError('Set up your LLM connection in Settings first.');
      return;
    }
    // Keep the active character first: they lead the story.
    const chosen = selected
      .map((id) => characters.find((c) => c.id === id))
      .filter((c): c is CharacterConfig => !!c);
    setBusy(true);
    setError(null);
    try {
      const config = await generateStory(
        {
          characters: chosen,
          premise,
          stageCount,
          sequelOf: stories.find((s) => s.config.id === sequelOf),
        },
        llmConfig,
        chatFn,
      );
      setDraft(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={`${styles.panel} ${styles.panelWide}`}
        onClick={(e) => e.stopPropagation()}
        data-testid="story-generator"
      >
        <div className={styles.panelHeader}>
          <span className={styles.panelTitle}>Write a new story</span>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className={styles.panelBody}>
          {!draft ? (
            <>
              <div className={styles.field}>
                <label className={styles.label}>Characters (the first one you pick leads)</label>
                <div className={styles.emotionTags}>
                  {characters.map((c) => (
                    <label key={c.id} className={styles.emotionTag}>
                      <input
                        type="checkbox"
                        checked={selected.includes(c.id)}
                        onChange={() => toggle(c.id)}
                        data-testid={`story-char-${c.id}`}
                      />{' '}
                      {c.character_name}
                    </label>
                  ))}
                </div>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>What should it be about? (optional)</label>
                <textarea
                  className={styles.textarea}
                  rows={4}
                  value={premise}
                  onChange={(e) => setPremise(e.target.value)}
                  placeholder="A heist at a masked ball, a haunted lighthouse, Aoi crash-lands in Kestrel's tavern..."
                  data-testid="story-premise"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Stages</label>
                <input
                  className={styles.input}
                  type="number"
                  min={MIN_STAGES}
                  max={MAX_STAGES}
                  value={stageCount}
                  onChange={(e) => setStageCount(Number(e.target.value) || MIN_STAGES)}
                  data-testid="story-stages"
                />
              </div>
              {stories.length > 0 && (
                <div className={styles.field}>
                  <label className={styles.label}>Continue from (optional)</label>
                  <select
                    className={styles.input}
                    value={sequelOf}
                    onChange={(e) => setSequelOf(e.target.value)}
                    data-testid="story-sequel"
                  >
                    <option value="">A new story</option>
                    {stories.map((s) => (
                      <option key={s.config.id} value={s.config.id}>
                        Sequel to {s.config.mod_name_en || s.config.mod_name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {error && (
                <div className={styles.modDesc} role="alert" data-testid="story-error">
                  {error}
                </div>
              )}
            </>
          ) : (
            <div className={styles.progressView} data-testid="story-preview">
              <div className={styles.modTitle}>{draft.mod_name_en}</div>
              {draft.display_desc && <div className={styles.modDesc}>{draft.display_desc}</div>}
              <div className={styles.label}>Cast</div>
              <ul className={styles.targetList}>
                {(draft.cast ?? []).map((m) => (
                  <li key={m.id} className={styles.targetItem}>
                    <strong>{m.name}</strong>: {m.role}
                  </li>
                ))}
              </ul>
              <div className={styles.label}>Stages</div>
              <ol className={styles.targetList}>
                {Object.values(draft.stages)
                  .sort((a, b) => a.stage_index - b.stage_index)
                  .map((s) => (
                    <li key={s.stage_index} className={styles.targetItem}>
                      {s.stage_name}
                    </li>
                  ))}
              </ol>
            </div>
          )}
        </div>

        <div className={styles.panelFooter}>
          {draft && (
            <button className={styles.cancelBtn} onClick={() => setDraft(null)}>
              Back
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          {draft ? (
            <button
              className={styles.saveBtn}
              onClick={() => onCreate(draft)}
              data-testid="story-create"
            >
              Start this story
            </button>
          ) : (
            <button
              className={styles.saveBtn}
              onClick={handleGenerate}
              disabled={busy || selected.length === 0}
              data-testid="story-generate"
            >
              <Sparkles size={14} /> {busy ? 'Writing...' : 'Write it'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default StoryGenerator;
