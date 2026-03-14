interface Props {
  currentStep: number;
  totalSteps: number;
  labels: string[];
  onStepClick?: (step: number) => void;
}

export default function StepIndicator({ currentStep, totalSteps, labels, onStepClick }: Props) {
  return (
    <div className="mb-9">
      {/* Equal-width grid so nodes are always evenly spaced */}
      <div className="relative flex items-start justify-between">

        {/* Background connector track */}
        <div
          className="absolute left-4 right-4 h-px"
          style={{ top: '16px', background: 'var(--border-muted)' }}
        />

        {/* Filled connector up to current step */}
        {currentStep > 1 && (
          <div
            className="absolute h-px transition-all duration-500"
            style={{
              top: '16px',
              left: '16px',
              // Each segment is 100% / (totalSteps - 1) wide; fill (currentStep - 1) segments
              width: `calc(${((currentStep - 1) / (totalSteps - 1)) * 100}% - 32px)`,
              background: 'var(--gold-faint)',
            }}
          />
        )}

        {/* Step nodes */}
        {Array.from({ length: totalSteps }, (_, i) => {
          const step = i + 1;
          const isCompleted = step < currentStep;
          const isActive = step === currentStep;
          const isClickable = isCompleted && !!onStepClick;

          return (
            <div
              key={step}
              className="relative flex flex-col items-center z-10"
              style={{ flex: '0 0 auto' }}
            >
              <button
                type="button"
                disabled={!isClickable}
                onClick={() => isClickable && onStepClick(step)}
                className={`w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300 ${
                  isClickable ? 'cursor-pointer hover:scale-110' : 'cursor-default'
                }`}
                style={{
                  background: isActive
                    ? 'var(--gold)'
                    : isCompleted
                      ? 'var(--gold-faint)'
                      : 'var(--bg-elevated)',
                  border: isActive
                    ? '2px solid var(--gold)'
                    : isCompleted
                      ? '2px solid var(--gold-faint)'
                      : '2px solid var(--border-solid)',
                  boxShadow: isActive ? '0 0 0 4px rgba(30,58,95,0.18)' : 'none',
                }}
              >
                {isCompleted ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    style={{ color: 'var(--gold)' }}>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <span className="font-mono text-xs font-medium"
                    style={{ color: isActive ? '#ffffff' : 'var(--text-muted)' }}>
                    {step}
                  </span>
                )}
              </button>

              <span
                className="mt-2 font-mono text-[10px] uppercase tracking-wider text-center transition-colors"
                style={{
                  color: isActive ? 'var(--gold)' : isCompleted ? 'var(--text-secondary)' : 'var(--text-muted)',
                  maxWidth: '80px',
                  lineHeight: '1.3',
                }}
              >
                {labels[i]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
