interface Props {
  value: string;
  onChange: (text: string) => void;
  description?: string;
  onDescriptionChange?: (text: string) => void;
}

const MIN_LENGTH = 10;
const SOFT_MAX = 500;

export default function StepThree({ value, onChange, description = '', onDescriptionChange }: Props) {
  const charCount = value.length;
  const isUnder = charCount < MIN_LENGTH;
  const isOver = charCount > SOFT_MAX;

  return (
    <div>
      <h2 className="text-xl font-semibold text-slate-800 mb-1">Describe your key idea</h2>
      <p className="text-sm text-slate-500 mb-6">
        State your central research question or argument. Be as specific as possible — this seeds the literature search and AI summarization pipeline.
      </p>

      <div className="relative">
        <textarea
          rows={7}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. Examining the longitudinal effects of Cognitive Behavioral Therapy on treatment-resistant depression in adolescents, with a focus on biomarker changes over a 12-month follow-up period."
          className={`
            w-full rounded-xl border-2 p-4 text-sm text-slate-800 placeholder-slate-400
            resize-none transition-all duration-200 focus:outline-none leading-relaxed
            ${isOver
              ? 'border-amber-400 focus:border-amber-500 focus:ring-2 focus:ring-amber-100'
              : 'border-slate-200 focus:border-brand-500 focus:ring-2 focus:ring-brand-100'
            }
          `}
        />
        {/* Character counter */}
        <div className={`absolute bottom-3 right-4 text-xs font-medium tabular-nums ${
          isOver ? 'text-amber-500' : 'text-slate-400'
        }`}>
          {charCount} / {SOFT_MAX}
        </div>
      </div>

      {/* Hints */}
      {isUnder && charCount > 0 && (
        <p className="mt-2 text-xs text-rose-500">
          Please provide at least {MIN_LENGTH} characters.
        </p>
      )}
      {isOver && (
        <p className="mt-2 text-xs text-amber-600">
          Consider distilling your idea to its core argument for better AI performance.
        </p>
      )}

      {/* Project description (optional) */}
      {onDescriptionChange && (
        <div className="mt-5">
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Project description <span className="text-slate-400 font-normal">(optional)</span>
          </label>
          <textarea
            rows={2}
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="e.g. Systematic review for my PhD chapter on AI chatbots in healthcare"
            className="w-full rounded-xl border-2 border-slate-200 p-3 text-sm text-slate-800
              placeholder-slate-400 resize-none transition-all duration-200 focus:outline-none
              leading-relaxed focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </div>
      )}

      {/* Tips box */}
      <div className="mt-5 rounded-xl bg-slate-100 border border-slate-200 p-4">
        <p className="text-xs font-semibold text-slate-600 mb-2 uppercase tracking-wide">Tips for a strong prompt</p>
        <ul className="space-y-1.5 text-xs text-slate-500 list-none">
          {[
            'Mention the population or sample (e.g., "adolescents aged 13–17").',
            'Include the intervention or variable of interest.',
            'State the outcome measure or dependent variable.',
            'Note the time frame or study design if relevant.',
          ].map((tip) => (
            <li key={tip} className="flex items-start gap-2">
              <span className="text-brand-400 mt-0.5">→</span>
              {tip}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
