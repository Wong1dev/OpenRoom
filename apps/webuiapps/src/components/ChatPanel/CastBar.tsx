import React from 'react';
import { resolveEmotionMedia, type CharacterConfig } from '@/lib/characterManager';
import type { ModManager } from '@/lib/modManager';
import { castMemberToCharacter, isIntroduced } from '@/lib/storyCast';
import styles from './index.module.scss';

/**
 * The story's cast as a row of chips. The current speaker is highlighted;
 * tapping another (introduced) member makes them the speaker. Members the user
 * has not met yet are shown as a dimmed "?" so the cast list does not spoil the plot.
 */
const CastBar: React.FC<{
  modManager: ModManager;
  characters: Record<string, CharacterConfig>;
  disabled?: boolean;
  onSelect: (castId: string) => void;
}> = ({ modManager, characters, disabled, onSelect }) => {
  const cast = modManager.cast;
  const state = modManager.getState();
  const leadId = modManager.getConfig().lead_id;
  const speakerId = modManager.speakerId;

  return (
    <div className={styles.castBar} data-testid="cast-bar">
      {cast.map((member) => {
        const met = isIntroduced(cast, state, member.id, leadId);
        const active = member.id === speakerId;
        if (!met) {
          return (
            <span
              key={member.id}
              className={`${styles.castChip} ${styles.castChipUnknown}`}
              title="Not met yet"
              data-testid={`cast-chip-${member.id}`}
            >
              <span className={styles.castAvatar}>?</span>
            </span>
          );
        }
        const asCharacter = castMemberToCharacter(member, characters);
        const meta = asCharacter.character_meta_info;
        const media = resolveEmotionMedia(asCharacter, 'default');
        const img =
          meta?.avatar_img_url ??
          meta?.base_image_url ??
          (media?.type === 'image' ? media.url : undefined);
        return (
          <button
            key={member.id}
            type="button"
            className={`${styles.castChip} ${active ? styles.castChipActive : ''}`}
            onClick={() => onSelect(member.id)}
            disabled={disabled || active}
            title={`${member.name}: ${member.role}`}
            aria-pressed={active}
            data-testid={`cast-chip-${member.id}`}
          >
            <span className={styles.castAvatar}>
              {img ? <img src={img} alt="" /> : member.name.charAt(0)}
            </span>
            <span className={styles.castName}>{member.name}</span>
          </button>
        );
      })}
    </div>
  );
};

export default CastBar;
