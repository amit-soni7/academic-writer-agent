import type { ArticleMode } from '../../types/intent';

interface Props {
  value: ArticleMode | null;
  onChange: (mode: ArticleMode) => void;
}

const options: { value: ArticleMode; label: string; description: string; glyph: string }[] = [
  {
    value: 'novel',
    label: 'Novel Submission',
    description: 'Writing a new, original manuscript from scratch for first submission.',
    glyph: '✦',
  },
  {
    value: 'revision',
    label: 'Peer-Review Revision',
    description: 'Revising a manuscript in response to reviewer feedback and editorial decision.',
    glyph: '↺',
  },
];

export default function StepOne({ value, onChange }: Props) {
  return (
    <div>
      <h2
        className="text-2xl font-light mb-1 leading-snug"
        style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', color: 'var(--text-bright)' }}
      >
        What are you working on?
      </h2>
      <p className="text-sm text-slate-500 mb-7 leading-relaxed">
        Select the stage of your manuscript to tailor the AI pipeline accordingly.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {options.map((opt) => {
          const isSelected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`
                relative text-left p-5 rounded-lg border transition-all duration-200
                focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500
                ${isSelected
                  ? 'border-brand-500 bg-brand-50'
                  : 'border-slate-200 hover:border-slate-300 hover:bg-slate-100'
                }
              `}
              style={isSelected ? { boxShadow: '0 0 0 1px var(--gold), inset 0 1px 0 rgba(30,58,95,0.06)' } : undefined}
            >
              {/* Glyph */}
              <span
                className="block text-3xl mb-4 leading-none font-light select-none"
                style={{
                  fontFamily: 'Georgia, serif',
                  color: isSelected ? 'var(--gold)' : 'var(--text-muted)',
                  transition: 'color 0.2s',
                }}
              >
                {opt.glyph}
              </span>

              {/* Label */}
              <span
                className="block font-semibold text-sm mb-1.5 leading-tight"
                style={{ color: isSelected ? 'var(--gold-light)' : 'var(--text-body)' }}
              >
                {opt.label}
              </span>

              {/* Description */}
              <span className="block text-xs text-slate-500 leading-relaxed">
                {opt.description}
              </span>

              {/* Selected indicator */}
              {isSelected && (
                <span
                  className="absolute top-3 right-3 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: 'var(--gold)', color: '#ffffff' }}
                >
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
