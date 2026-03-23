import type { WritingType } from '../../types/intent';

interface Props {
  value: WritingType | null;
  onChange: (type: WritingType) => void;
}

type OptionGroup = {
  group: string;
  items: { value: WritingType; label: string; description: string }[];
};

const OPTION_GROUPS: OptionGroup[] = [
  {
    group: 'Study Protocols',
    items: [
      {
        value: 'study_protocol',
        label: 'Study Protocol',
        description:
          'Full protocol paper for an interventional or observational study before data collection. Follows SPIRIT 2013 guidelines. Covers RCT, cohort, cross-sectional, and other designs.',
      },
    ],
  },
  {
    group: 'Primary Research',
    items: [
      {
        value: 'original_research',
        label: 'Original Research',
        description:
          'Empirical study with novel data collection and analysis. Follows IMRAD structure: Introduction, Methods, Results, Discussion.',
      },
      {
        value: 'case_report',
        label: 'Case Report',
        description:
          'Detailed report of an individual patient or unusual clinical case. Follows CARE guidelines.',
      },
      {
        value: 'brief_report',
        label: 'Brief / Short Report',
        description:
          'Concise presentation of preliminary or focused findings. Shorter word limit than a full original article.',
      },
    ],
  },
  {
    group: 'Reviews & Synthesis',
    items: [
      {
        value: 'systematic_review',
        label: 'Systematic Review',
        description:
          'Comprehensive, reproducible literature search answering a focused PICO question. Follows PRISMA 2020 guidelines.',
      },
      {
        value: 'scoping_review',
        label: 'Scoping Review',
        description:
          'Maps the breadth of evidence on a topic using PCC framework. Follows PRISMA-ScR. No meta-analytic pooling.',
      },
      {
        value: 'narrative_review',
        label: 'Narrative Review',
        description:
          'Thematic synthesis of the literature with a transparent search approach but without full PRISMA methodology.',
      },
      {
        value: 'meta_analysis',
        label: 'Meta-Analysis',
        description:
          'Statistical pooling of results across multiple studies. Reports pooled estimates, I², heterogeneity, and publication bias.',
      },
    ],
  },
  {
    group: 'Commentary & Opinion',
    items: [
      {
        value: 'opinion',
        label: 'Opinion / Commentary',
        description:
          'Expert perspective or critical commentary on a topic, supported by evidence.',
      },
      {
        value: 'editorial',
        label: 'Editorial',
        description:
          'Editor- or author-invited piece addressing a field-level issue or contextualising a research finding.',
      },
      {
        value: 'letter',
        label: 'Letter to the Editor',
        description:
          'Concise (400–600 word) response to a published article or brief original observation.',
      },
    ],
  },
];

export default function StepTwo({ value, onChange }: Props) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-slate-800 mb-1">Article type</h2>
      <p className="text-sm text-slate-500 mb-6">
        Choose the format that best describes your manuscript. This determines the
        structural template, section headings, and reporting guidelines used during writing.
      </p>

      <div className="space-y-6">
        {OPTION_GROUPS.map((group) => (
          <div key={group.group}>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
              {group.group}
            </p>
            <div className="space-y-2">
              {group.items.map((opt) => {
                const isSelected = value === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={`
                      flex items-start gap-4 p-4 rounded-xl border-2 cursor-pointer
                      transition-all duration-200
                      ${isSelected
                        ? 'border-brand-500 bg-brand-50'
                        : 'border-slate-200 bg-white hover:border-brand-200 hover:bg-slate-50'
                      }
                    `}
                  >
                    {/* Custom radio */}
                    <div className={`
                      mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0
                      transition-all duration-200
                      ${isSelected ? 'border-brand-500' : 'border-slate-300'}
                    `}>
                      {isSelected && <div className="w-2.5 h-2.5 rounded-full bg-brand-500" />}
                    </div>
                    <input
                      type="radio"
                      name="writing_type"
                      value={opt.value}
                      checked={isSelected}
                      onChange={() => onChange(opt.value)}
                      className="sr-only"
                    />
                    <div>
                      <span className={`block font-medium text-sm ${isSelected ? 'text-brand-700' : 'text-slate-700'}`}>
                        {opt.label}
                      </span>
                      <span className="block text-xs text-slate-500 mt-0.5 leading-relaxed">
                        {opt.description}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
