/**
 * StepOne — Two-card mode selector: Novel Article or Revise Manuscript.
 */
import type { ArticleMode } from '../../types/intent';

interface Props {
  mode: ArticleMode | null;
  onSelect: (mode: ArticleMode) => void;
}

const CARDS: { id: ArticleMode; glyph: string; label: string; description: string }[] = [
  {
    id: 'novel',
    glyph: '✦',
    label: 'Novel Article',
    description: 'Write a new manuscript — original research, review, commentary, or any other article type.',
  },
  {
    id: 'revision',
    glyph: '↺',
    label: 'Revise Manuscript',
    description: 'Respond to peer-reviewer comments and generate a point-by-point response letter.',
  },
];

export default function StepOne({ mode, onSelect }: Props) {
  return (
    <div>
      <h2
        className="text-2xl font-light mb-1 leading-snug"
        style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}
      >
        What are you working on?
      </h2>
      <p className="text-sm text-slate-500 mb-6 leading-relaxed">
        Select the type of work to tailor the pipeline accordingly.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {CARDS.map((card) => {
          const isActive = mode === card.id;
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => onSelect(card.id)}
              className={`text-left p-5 rounded-xl border-2 transition-all duration-200 focus:outline-none ${
                isActive
                  ? 'border-amber-400/70 bg-amber-50/40'
                  : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50/60'
              }`}
              style={isActive ? { boxShadow: '0 0 0 1px var(--gold)' } : undefined}
            >
              <span
                className="block text-3xl mb-3 leading-none select-none"
                style={{ color: isActive ? 'var(--gold)' : 'var(--text-muted)' }}
              >
                {card.glyph}
              </span>
              <span
                className="block text-sm font-semibold mb-1.5"
                style={{ color: isActive ? 'var(--gold-light)' : 'var(--text-body)' }}
              >
                {card.label}
              </span>
              <span className="block text-xs text-slate-500 leading-relaxed">{card.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
