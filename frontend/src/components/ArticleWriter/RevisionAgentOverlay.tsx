interface Props {
  stage: string;
  currentRound: number;
  status?: string;
  celebrate?: boolean;
  completedReason?: string;
}

const stageMessages: Record<string, string> = {
  starting: 'Initializing the revision pipeline.',
  action_map: 'Mapping reviewer concerns to concrete manuscript edits.',
  revise_manuscript: 'Writing the revised manuscript with anchored changes.',
  preservation_audit: 'Checking structure, integrity, and preserved intent.',
  reviewer_recheck: 'Re-checking the revision against reviewer concerns.',
  editor_assessment: 'Running the editorial assessment on the current draft.',
  followup_revision: 'Repairing every validated issue in one follow-up pass.',
  completing_truncated: 'Repairing damaged passages with full-context rewrites.',
  final_response: 'Writing the final response letter from applied changes.',
  export_generation: 'Preparing manuscript and response exports.',
  completed: 'Revision pipeline completed successfully.',
};

const mapStages = new Set(['starting', 'action_map']);
const writingStages = new Set(['revise_manuscript', 'followup_revision', 'final_response', 'completing_truncated']);

function MapAnimation() {
  return (
    <div className="revision-overlay-visual revision-overlay-map" aria-hidden="true">
      <div className="revision-overlay-grid" />
      <div className="revision-overlay-path revision-overlay-path-a" />
      <div className="revision-overlay-path revision-overlay-path-b" />
      <div className="revision-overlay-node revision-overlay-node-a" />
      <div className="revision-overlay-node revision-overlay-node-b" />
      <div className="revision-overlay-node revision-overlay-node-c" />
      <div className="revision-overlay-pin" />
    </div>
  );
}

function WritingAnimation() {
  return (
    <div className="revision-overlay-visual revision-overlay-writing" aria-hidden="true">
      <div className="revision-overlay-paper">
        <span className="revision-overlay-line revision-overlay-line-a" />
        <span className="revision-overlay-line revision-overlay-line-b" />
        <span className="revision-overlay-line revision-overlay-line-c" />
        <span className="revision-overlay-line revision-overlay-line-d" />
      </div>
      <div className="revision-overlay-pen">
        <span className="revision-overlay-pen-tip" />
      </div>
    </div>
  );
}

function ReviewAnimation() {
  return (
    <div className="revision-overlay-visual revision-overlay-review" aria-hidden="true">
      <div className="revision-overlay-sheet revision-overlay-sheet-back" />
      <div className="revision-overlay-sheet revision-overlay-sheet-front">
        <span className="revision-overlay-sheet-line revision-overlay-sheet-line-a" />
        <span className="revision-overlay-sheet-line revision-overlay-sheet-line-b" />
        <span className="revision-overlay-sheet-line revision-overlay-sheet-line-c" />
      </div>
      <div className="revision-overlay-scanbar" />
      <div className="revision-overlay-lens">
        <span className="revision-overlay-lens-handle" />
      </div>
    </div>
  );
}

function SuccessAnimation() {
  return (
    <div className="revision-overlay-success-mark" aria-hidden="true">
      <div className="revision-overlay-success-ring" />
      <div className="revision-overlay-success-core">
        <span className="material-symbols-outlined">check</span>
      </div>
    </div>
  );
}

function SuccessConfetti() {
  return (
    <div className="revision-overlay-confetti" aria-hidden="true">
      {Array.from({ length: 24 }, (_, index) => (
        <span
          key={index}
          className="revision-overlay-confetti-piece"
          style={{
            left: `${4 + index * 4}%`,
            animationDelay: `${(index % 6) * 0.18}s`,
            animationDuration: `${2.2 + (index % 5) * 0.16}s`,
          }}
        />
      ))}
    </div>
  );
}

export default function RevisionAgentOverlay({
  stage,
  currentRound,
  status = 'idle',
  celebrate = false,
  completedReason = '',
}: Props) {
  const isSuccess = celebrate || status === 'completed' || stage === 'completed';
  const message = stageMessages[stage] || 'Processing the revision pipeline.';

  let visual = <ReviewAnimation />;
  if (mapStages.has(stage)) {
    visual = <MapAnimation />;
  } else if (writingStages.has(stage)) {
    visual = <WritingAnimation />;
  } else if (isSuccess) {
    visual = <SuccessAnimation />;
  }

  return (
    <div
      className={`revision-overlay-shell ${isSuccess ? 'revision-overlay-shell-success' : 'revision-overlay-shell-active'}`}
      aria-live="polite"
    >
      <style>{`
        @keyframes revisionOverlayPulse {
          0%, 100% { transform: scale(1); opacity: 0.85; }
          50% { transform: scale(1.08); opacity: 1; }
        }
        @keyframes revisionOverlayPing {
          0% { transform: scale(0.8); opacity: 0.7; }
          100% { transform: scale(1.8); opacity: 0; }
        }
        @keyframes revisionOverlayDash {
          0% { stroke-dashoffset: 0; }
          100% { stroke-dashoffset: -120; }
        }
        @keyframes revisionOverlayPinTravel {
          0%, 100% { transform: translate(0, 0); }
          30% { transform: translate(42px, -18px); }
          65% { transform: translate(84px, 12px); }
        }
        @keyframes revisionOverlayWrite {
          0%, 100% { transform: translate(0, 0) rotate(12deg); }
          25% { transform: translate(18px, 4px) rotate(10deg); }
          50% { transform: translate(40px, 12px) rotate(9deg); }
          75% { transform: translate(18px, 22px) rotate(12deg); }
        }
        @keyframes revisionOverlayInk {
          0%, 100% { transform: scaleX(0.35); opacity: 0.4; }
          50% { transform: scaleX(1); opacity: 0.95; }
        }
        @keyframes revisionOverlayScan {
          0% { transform: translateY(-60px); opacity: 0; }
          20% { opacity: 1; }
          80% { opacity: 1; }
          100% { transform: translateY(70px); opacity: 0; }
        }
        @keyframes revisionOverlayLens {
          0%, 100% { transform: translate(-18px, -12px); }
          50% { transform: translate(20px, 14px); }
        }
        @keyframes revisionOverlayConfetti {
          0% { transform: translateY(-12vh) rotate(0deg); opacity: 0; }
          12% { opacity: 1; }
          100% { transform: translateY(108vh) rotate(540deg); opacity: 0; }
        }
        @keyframes revisionOverlaySuccessPop {
          0% { transform: scale(0.6); opacity: 0; }
          55% { transform: scale(1.06); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }

        .revision-overlay-shell {
          position: fixed;
          inset: 0;
          z-index: 50;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .revision-overlay-shell-active {
          background:
            radial-gradient(circle at top, var(--gold-faint, rgba(79, 70, 229, 0.12)), transparent 45%),
            rgba(10, 16, 32, 0.18);
          backdrop-filter: blur(10px);
        }
        .revision-overlay-shell-success {
          pointer-events: none;
          background: transparent;
        }
        .revision-overlay-card {
          position: relative;
          overflow: hidden;
          width: min(92vw, 420px);
          border-radius: 28px;
          border: 1px solid var(--border-muted, rgba(199, 196, 216, 0.3));
          background:
            linear-gradient(160deg, var(--bg-surface, #ffffff), var(--bg-elevated, #edeeef));
          box-shadow: 0 28px 80px rgba(15, 23, 42, 0.18);
        }
        .revision-overlay-card-success {
          width: min(88vw, 360px);
          background: rgba(255, 255, 255, 0.82);
          border-color: var(--gold-faint, rgba(79, 70, 229, 0.12));
          box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
          animation: revisionOverlaySuccessPop 420ms ease-out both;
        }
        .revision-overlay-card::before {
          content: "";
          position: absolute;
          inset: 0;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.16), transparent 38%),
            radial-gradient(circle at 80% 20%, var(--gold-faint, rgba(79, 70, 229, 0.12)), transparent 28%);
          pointer-events: none;
        }
        .revision-overlay-content {
          position: relative;
          padding: 28px 28px 24px;
        }
        .revision-overlay-kicker {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: 999px;
          background: var(--gold-faint, rgba(79, 70, 229, 0.08));
          color: var(--gold, #4f46e5);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .revision-overlay-title {
          margin-top: 16px;
          font-size: 18px;
          line-height: 1.3;
          font-weight: 700;
          color: var(--text-bright, #191c1d);
        }
        .revision-overlay-text {
          margin-top: 8px;
          font-size: 13px;
          line-height: 1.6;
          color: var(--text-secondary, #64748b);
        }
        .revision-overlay-round {
          margin-top: 14px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 7px 11px;
          border-radius: 999px;
          border: 1px solid var(--border-faint, rgba(199, 196, 216, 0.15));
          background: rgba(255, 255, 255, 0.7);
          color: var(--text-secondary, #64748b);
          font-size: 11px;
          font-weight: 600;
        }
        .revision-overlay-visual {
          position: relative;
          margin: 0 auto;
          width: 180px;
          height: 140px;
        }
        .revision-overlay-map {
          border-radius: 26px;
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(255, 255, 255, 0.42)),
            var(--bg-base, #f8f9fa);
          border: 1px solid var(--border-faint, rgba(199, 196, 216, 0.15));
        }
        .revision-overlay-grid {
          position: absolute;
          inset: 14px;
          border-radius: 18px;
          background-image:
            linear-gradient(rgba(79, 70, 229, 0.08) 1px, transparent 1px),
            linear-gradient(90deg, rgba(79, 70, 229, 0.08) 1px, transparent 1px);
          background-size: 24px 24px;
        }
        .revision-overlay-path {
          position: absolute;
          height: 2px;
          border-radius: 999px;
          background: linear-gradient(90deg, transparent, var(--gold-light, #6366f1), transparent);
          opacity: 0.9;
        }
        .revision-overlay-path-a {
          left: 34px;
          top: 54px;
          width: 56px;
          transform: rotate(-18deg);
        }
        .revision-overlay-path-b {
          left: 86px;
          top: 70px;
          width: 48px;
          transform: rotate(22deg);
        }
        .revision-overlay-node,
        .revision-overlay-pin {
          position: absolute;
          border-radius: 999px;
          background: var(--gold, #4f46e5);
        }
        .revision-overlay-node {
          width: 12px;
          height: 12px;
          box-shadow: 0 0 0 8px rgba(79, 70, 229, 0.08);
          animation: revisionOverlayPulse 1.8s ease-in-out infinite;
        }
        .revision-overlay-node-a { left: 28px; top: 46px; }
        .revision-overlay-node-b { left: 84px; top: 58px; animation-delay: 0.2s; }
        .revision-overlay-node-c { left: 130px; top: 86px; animation-delay: 0.4s; }
        .revision-overlay-pin {
          width: 16px;
          height: 16px;
          left: 22px;
          top: 40px;
          box-shadow: 0 0 0 10px rgba(79, 70, 229, 0.12);
          animation: revisionOverlayPinTravel 2.6s ease-in-out infinite;
        }
        .revision-overlay-writing {
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .revision-overlay-paper {
          position: absolute;
          left: 32px;
          top: 18px;
          width: 112px;
          height: 104px;
          border-radius: 20px;
          border: 1px solid var(--border-faint, rgba(199, 196, 216, 0.15));
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.72));
          box-shadow: 0 16px 30px rgba(15, 23, 42, 0.08);
        }
        .revision-overlay-line {
          position: absolute;
          left: 18px;
          height: 7px;
          border-radius: 999px;
          transform-origin: left center;
          background: linear-gradient(90deg, var(--gold, #4f46e5), rgba(79, 70, 229, 0.18));
          animation: revisionOverlayInk 1.8s ease-in-out infinite;
        }
        .revision-overlay-line-a { top: 24px; width: 58px; }
        .revision-overlay-line-b { top: 42px; width: 72px; animation-delay: 0.2s; }
        .revision-overlay-line-c { top: 60px; width: 64px; animation-delay: 0.35s; }
        .revision-overlay-line-d { top: 78px; width: 50px; animation-delay: 0.5s; }
        .revision-overlay-pen {
          position: absolute;
          right: 22px;
          top: 44px;
          width: 62px;
          height: 16px;
          border-radius: 999px;
          background: linear-gradient(90deg, var(--gold-light, #6366f1), var(--gold, #4f46e5));
          transform-origin: left center;
          animation: revisionOverlayWrite 2.2s ease-in-out infinite;
          box-shadow: 0 10px 24px rgba(79, 70, 229, 0.18);
        }
        .revision-overlay-pen-tip {
          position: absolute;
          right: -5px;
          top: 4px;
          width: 0;
          height: 0;
          border-left: 10px solid var(--text-bright, #191c1d);
          border-top: 4px solid transparent;
          border-bottom: 4px solid transparent;
        }
        .revision-overlay-review {
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .revision-overlay-sheet {
          position: absolute;
          border-radius: 18px;
          border: 1px solid var(--border-faint, rgba(199, 196, 216, 0.15));
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.74));
        }
        .revision-overlay-sheet-back {
          inset: 26px 34px 24px 48px;
          transform: rotate(-5deg);
          opacity: 0.6;
        }
        .revision-overlay-sheet-front {
          inset: 16px 42px 20px 36px;
          box-shadow: 0 16px 28px rgba(15, 23, 42, 0.1);
        }
        .revision-overlay-sheet-line {
          position: absolute;
          left: 18px;
          right: 22px;
          height: 6px;
          border-radius: 999px;
          background: rgba(79, 70, 229, 0.14);
        }
        .revision-overlay-sheet-line-a { top: 24px; }
        .revision-overlay-sheet-line-b { top: 42px; width: calc(100% - 58px); }
        .revision-overlay-sheet-line-c { top: 60px; width: calc(100% - 42px); }
        .revision-overlay-scanbar {
          position: absolute;
          inset: 22px 42px;
          border-radius: 999px;
          background: linear-gradient(180deg, transparent, rgba(79, 70, 229, 0.25), transparent);
          animation: revisionOverlayScan 2.4s ease-in-out infinite;
        }
        .revision-overlay-lens {
          position: absolute;
          left: 100px;
          top: 56px;
          width: 34px;
          height: 34px;
          border-radius: 999px;
          border: 4px solid var(--gold, #4f46e5);
          background: rgba(255, 255, 255, 0.5);
          animation: revisionOverlayLens 2.8s ease-in-out infinite;
        }
        .revision-overlay-lens-handle {
          position: absolute;
          right: -10px;
          bottom: -12px;
          width: 16px;
          height: 4px;
          border-radius: 999px;
          background: var(--gold, #4f46e5);
          transform: rotate(40deg);
        }
        .revision-overlay-success-mark {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 140px;
          height: 140px;
          margin: 0 auto;
        }
        .revision-overlay-success-ring,
        .revision-overlay-success-ring::after {
          position: absolute;
          inset: 14px;
          border-radius: 999px;
          border: 1px solid rgba(79, 70, 229, 0.18);
          content: "";
          animation: revisionOverlayPing 1.8s ease-out infinite;
        }
        .revision-overlay-success-ring::after {
          inset: 0;
          animation-delay: 0.35s;
        }
        .revision-overlay-success-core {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 76px;
          height: 76px;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--gold, #4f46e5), var(--gold-light, #6366f1));
          box-shadow: 0 18px 34px rgba(79, 70, 229, 0.26);
          color: white;
        }
        .revision-overlay-success-core .material-symbols-outlined {
          font-size: 34px;
          font-variation-settings: "FILL" 1;
        }
        .revision-overlay-confetti {
          position: fixed;
          inset: 0;
          overflow: hidden;
          pointer-events: none;
        }
        .revision-overlay-confetti-piece {
          position: absolute;
          top: -8vh;
          width: 10px;
          height: 18px;
          border-radius: 999px;
          background: linear-gradient(180deg, var(--gold-light, #6366f1), var(--gold, #4f46e5));
          opacity: 0;
          animation-name: revisionOverlayConfetti;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        .revision-overlay-confetti-piece:nth-child(3n) {
          background: rgba(79, 70, 229, 0.24);
        }
        .revision-overlay-confetti-piece:nth-child(4n) {
          background: rgba(25, 28, 29, 0.18);
          height: 12px;
        }
      `}</style>

      {isSuccess && <SuccessConfetti />}

      <div className={`revision-overlay-card ${isSuccess ? 'revision-overlay-card-success' : ''}`}>
        <div className="revision-overlay-content">
          {visual}
          <div className="revision-overlay-kicker">
            <span className="material-symbols-outlined text-sm">
              {isSuccess ? 'celebration' : 'auto_awesome'}
            </span>
            {isSuccess ? 'Revision Complete' : 'AI Revision Manager'}
          </div>
          <div className="revision-overlay-title">
            {isSuccess ? 'All revision stages cleared.' : message}
          </div>
          <div className="revision-overlay-text">
            {isSuccess
              ? (completedReason || 'The manuscript, QA checks, and exports are ready.')
              : 'The revision tab stays live while the agent maps changes, repairs the manuscript, and checks the result.'}
          </div>
          {!isSuccess && currentRound > 0 && (
            <div className="revision-overlay-round">
              <span className="material-symbols-outlined text-sm">cycle</span>
              Round {currentRound}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
