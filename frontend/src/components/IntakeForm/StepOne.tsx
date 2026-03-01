import type { ArticleMode } from '../../types/intent';

interface Props {
  value: ArticleMode | null;
  onChange: (mode: ArticleMode) => void;
}

const options: { value: ArticleMode; label: string; description: string; icon: string }[] = [
  {
    value: 'novel',
    label: 'Novel Submission',
    description: 'Writing a new, original manuscript from scratch for first submission.',
    icon: '✦',
  },
  {
    value: 'revision',
    label: 'Revision',
    description: 'Revising a manuscript in response to peer-review feedback.',
    icon: '↺',
  },
];

export default function StepOne({ value, onChange }: Props) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-slate-800 mb-1">What are you working on?</h2>
      <p className="text-sm text-slate-500 mb-6">
        Select the stage of your manuscript to tailor the pipeline accordingly.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {options.map((opt) => {
          const isSelected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`
                text-left p-5 rounded-xl border-2 transition-all duration-200 focus:outline-none
                focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2
                ${isSelected
                  ? 'border-brand-600 bg-brand-50 shadow-sm'
                  : 'border-slate-200 bg-white hover:border-brand-300 hover:shadow-sm'
                }
              `}
            >
              <span className={`text-2xl mb-3 block ${isSelected ? 'text-brand-600' : 'text-slate-400'}`}>
                {opt.icon}
              </span>
              <span className={`block font-semibold mb-1 ${isSelected ? 'text-brand-700' : 'text-slate-700'}`}>
                {opt.label}
              </span>
              <span className="block text-sm text-slate-500 leading-relaxed">
                {opt.description}
              </span>
              {isSelected && (
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand-600">
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                  </svg>
                  Selected
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
