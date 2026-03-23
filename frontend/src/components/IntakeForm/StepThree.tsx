interface Props {
  value: string;
  onChange: (text: string) => void;
  description?: string;
  onDescriptionChange?: (text: string) => void;
}

const MIN_LENGTH = 10;
const SOFT_MAX   = 500;

const tips = [
  'Mention the population or sample (e.g., "adolescents aged 13–17").',
  'Include the intervention or variable of interest.',
  'State the outcome measure or dependent variable.',
  'Note the time frame or study design if relevant.',
];

export default function StepThree({ value, onChange, description = '', onDescriptionChange }: Props) {
  const charCount = value.length;
  const isUnder   = charCount < MIN_LENGTH;
  const isOver    = charCount > SOFT_MAX;

  return (
    <div>
      <h2
        className="text-2xl font-light mb-1 leading-snug"
        style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-bright)' }}
      >
        Describe your key idea
      </h2>
      <p className="text-sm text-slate-500 mb-6 leading-relaxed">
        State your central research question or argument. Specificity here seeds the literature search and summarization pipeline.
      </p>

      <div className="relative">
        <textarea
          rows={7}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. Examining the longitudinal effects of Cognitive Behavioral Therapy on treatment-resistant depression in adolescents, with a focus on biomarker changes over a 12-month follow-up period."
          className="w-full rounded-lg border p-4 text-sm resize-none transition-all duration-200
            focus:outline-none leading-relaxed"
          style={{
            background: 'var(--bg-elevated)',
            color: 'var(--text-body)',
            borderColor: isOver ? '#d0aa58' : 'var(--border-muted)',
            caretColor: 'var(--gold)',
            boxShadow: isOver
              ? 'inset 0 0 0 1px rgba(208,170,88,0.4)'
              : 'inset 0 0 0 1px transparent',
          }}
          onFocus={(e) => {
            (e.target as HTMLTextAreaElement).style.borderColor = isOver ? '#d0aa58' : 'var(--gold)';
            (e.target as HTMLTextAreaElement).style.boxShadow = isOver
              ? 'inset 0 0 0 1px rgba(208,170,88,0.4)'
              : 'inset 0 0 0 1px rgba(196,147,70,0.3)';
          }}
          onBlur={(e) => {
            (e.target as HTMLTextAreaElement).style.borderColor = isOver ? '#d0aa58' : 'var(--border-muted)';
            (e.target as HTMLTextAreaElement).style.boxShadow = 'inset 0 0 0 1px transparent';
          }}
        />
        <div
          className="absolute bottom-3 right-4 font-mono text-[10px] tabular-nums"
          style={{ color: isOver ? '#d0aa58' : 'var(--text-muted)' }}
        >
          {charCount} / {SOFT_MAX}
        </div>
      </div>

      {isUnder && charCount > 0 && (
        <p className="mt-2 text-xs" style={{ color: '#d65454' }}>
          Please provide at least {MIN_LENGTH} characters.
        </p>
      )}
      {isOver && (
        <p className="mt-2 text-xs" style={{ color: '#d0aa58' }}>
          Consider distilling your idea to its core argument for better AI performance.
        </p>
      )}

      {onDescriptionChange && (
        <div className="mt-5">
          <label className="block text-xs font-mono uppercase tracking-wider mb-2"
            style={{ color: 'var(--text-secondary)' }}>
            Project description{' '}
            <span style={{ color: 'var(--text-muted)' }}>(optional)</span>
          </label>
          <textarea
            rows={2}
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="e.g. Systematic review for my PhD chapter on AI chatbots in healthcare"
            className="w-full rounded-lg border p-3 text-sm resize-none
              transition-all duration-200 focus:outline-none leading-relaxed"
            style={{
              background: 'var(--bg-elevated)',
              color: 'var(--text-body)',
              borderColor: 'var(--border-muted)',
              caretColor: 'var(--gold)',
            }}
            onFocus={(e) => { (e.target as HTMLTextAreaElement).style.borderColor = 'var(--gold)'; }}
            onBlur={(e)  => { (e.target as HTMLTextAreaElement).style.borderColor = 'var(--border-muted)'; }}
          />
        </div>
      )}

      {/* Tips */}
      <div
        className="mt-5 rounded-lg border p-4"
        style={{
          background: 'var(--bg-base)',
          borderColor: 'var(--border-faint)',
          borderLeft: '3px solid var(--gold-faint)',
        }}
      >
        <p className="font-mono text-[9px] uppercase tracking-[0.15em] mb-3"
          style={{ color: 'var(--gold)' }}>
          Tips for a strong prompt
        </p>
        <ul className="space-y-1.5">
          {tips.map((tip) => (
            <li key={tip} className="flex items-start gap-2 text-xs leading-relaxed"
              style={{ color: 'var(--text-muted)' }}>
              <span className="flex-shrink-0 mt-0.5" style={{ color: 'var(--gold-faint)' }}>›</span>
              {tip}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
