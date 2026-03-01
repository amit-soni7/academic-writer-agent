import Lottie from 'lottie-react';
import foridayLogoAnimation from '../assets/foriday-logo-lottie.json';

interface LoadingLottieProps {
  className?: string;
  label?: string;
  textClassName?: string;
}

export default function LoadingLottie({
  className = 'w-16 h-16',
  label,
  textClassName = 'text-sm text-slate-400',
}: LoadingLottieProps) {
  const wrapperClassName = label
    ? 'inline-flex flex-col items-center justify-center gap-2'
    : 'inline-flex items-center justify-center';

  return (
    <div className={wrapperClassName}>
      <Lottie
        animationData={foridayLogoAnimation}
        loop
        autoplay
        className={className}
        aria-hidden="true"
      />
      {label && <span className={textClassName}>{label}</span>}
    </div>
  );
}
