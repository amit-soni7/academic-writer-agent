interface Props {
  currentStep: number;
  totalSteps: number;
  labels: string[];
}

export default function StepIndicator({ currentStep, totalSteps, labels }: Props) {
  return (
    <div className="mb-10">
      <div className="flex items-center justify-between">
        {Array.from({ length: totalSteps }, (_, i) => {
          const step = i + 1;
          const isCompleted = step < currentStep;
          const isActive = step === currentStep;

          return (
            <div key={step} className="flex items-center flex-1">
              {/* Circle */}
              <div className="flex flex-col items-center">
                <div
                  className={`
                    w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold
                    transition-all duration-300
                    ${isCompleted ? 'bg-brand-600 text-white' : ''}
                    ${isActive ? 'bg-brand-600 text-white ring-4 ring-brand-100' : ''}
                    ${!isCompleted && !isActive ? 'bg-slate-200 text-slate-500' : ''}
                  `}
                >
                  {isCompleted ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    step
                  )}
                </div>
                <span
                  className={`mt-2 text-xs font-medium whitespace-nowrap ${
                    isActive ? 'text-brand-600' : isCompleted ? 'text-slate-600' : 'text-slate-400'
                  }`}
                >
                  {labels[i]}
                </span>
              </div>

              {/* Connector line */}
              {step < totalSteps && (
                <div className={`h-0.5 flex-1 mx-3 mt-[-18px] transition-all duration-500 ${
                  isCompleted ? 'bg-brand-600' : 'bg-slate-200'
                }`} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
