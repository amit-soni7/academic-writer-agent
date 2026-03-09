interface Props {
  currentStep: number;
  totalSteps: number;
  labels: string[];
}

export default function StepIndicator({ currentStep, totalSteps, labels }: Props) {
  return (
    <div className="mb-9">
      <div className="flex items-center">
        {Array.from({ length: totalSteps }, (_, i) => {
          const step = i + 1;
          const isCompleted = step < currentStep;
          const isActive    = step === currentStep;

          return (
            <div key={step} className="flex items-center flex-1">
              {/* Step node */}
              <div className="flex flex-col items-center">
                <div
                  className="relative w-8 h-8 rounded-full flex items-center justify-center
                    transition-all duration-300"
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
                    <span
                      className="font-mono text-xs font-medium"
                      style={{ color: isActive ? '#ffffff' : 'var(--text-muted)' }}
                    >
                      {step}
                    </span>
                  )}
                </div>

                <span
                  className="mt-2 font-mono text-[10px] uppercase tracking-wider whitespace-nowrap transition-colors"
                  style={{
                    color: isActive
                      ? 'var(--gold)'
                      : isCompleted
                        ? 'var(--text-secondary)'
                        : 'var(--text-muted)',
                  }}
                >
                  {labels[i]}
                </span>
              </div>

              {/* Connector line */}
              {step < totalSteps && (
                <div
                  className="h-px flex-1 mx-3 mt-[-18px] transition-all duration-500"
                  style={{
                    background: isCompleted
                      ? 'linear-gradient(90deg, var(--gold-faint), var(--border-solid))'
                      : 'var(--border-muted)',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
