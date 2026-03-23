import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  downloadPrismaPChecklistDocx,
  downloadProtocolDocx,
  getPrismaP,
  getProtocol,
  registerOSF,
  savePrismaP,
  streamGenerateProtocolFetch,
  type PrismaPData,
  type PrismaPAdministrative,
  type SRProtocol,
} from '../../api/sr';

interface Props {
  projectId: string;
  onBackToProtocol: () => void;
  onGoToSearch: () => void;
}

type BusyAction = 'idle' | 'generate' | 'protocol' | 'prisma' | 'osf';

const PROSPERO_URL = 'https://www.crd.york.ac.uk/prospero/';
const OSF_REGISTRIES_URL = 'https://osf.io/registries/';
const DEFAULT_FUNDING_NOTE = 'No specific funding was received for this protocol.';
const DEFAULT_COMPETING_INTERESTS = 'The authors declare no conflicts of interest.';
const DEFAULT_AMENDMENT_POLICY = 'Any important protocol amendments made after protocol export or registration will be documented with the date, rationale, and expected impact on the review methods and reporting.';

function titleCaseLabel(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractTitle(protocol: SRProtocol | null, prismaP: PrismaPData | null): string {
  const savedTitle = prismaP?.administrative?.review_title?.trim();
  if (savedTitle) return savedTitle;

  const match = protocol?.protocol_document?.match(/^#\s+(.+)$/m);
  if (match?.[1]) {
    return match[1].replace(/\s+[-\u2014]\s+Protocol$/, '').trim();
  }

  return 'Systematic Review Protocol';
}

function buildAdministrativeDraft(
  prismaP: PrismaPData | null,
  protocol: SRProtocol | null,
): PrismaPAdministrative {
  const admin = prismaP?.administrative || {};
  return {
    ...admin,
    review_title: admin.review_title?.trim() || extractTitle(protocol, prismaP),
    registration_name: admin.registration_name || '',
    registration_number: admin.registration_number || '',
    funding_sources: admin.funding_sources?.trim() || DEFAULT_FUNDING_NOTE,
    competing_interests: admin.competing_interests?.trim() || DEFAULT_COMPETING_INTERESTS,
    amendment_plan: admin.amendment_plan?.trim() || DEFAULT_AMENDMENT_POLICY,
    contributions: admin.contributions || '',
    sponsor_name: admin.sponsor_name || '',
    sponsor_role: admin.sponsor_role || '',
  };
}

function buildProsperoText(fields: Record<string, string>): string {
  return Object.entries(fields)
    .filter(([, value]) => String(value || '').trim().length > 0)
    .map(([key, value]) => `${titleCaseLabel(key)}\n${value}`)
    .join('\n\n');
}

function StatusChip({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'gold' | 'success' }) {
  const styles = tone === 'success'
    ? { background: 'rgba(16, 185, 129, 0.12)', color: '#047857', borderColor: 'rgba(16, 185, 129, 0.24)' }
    : tone === 'gold'
      ? { background: 'var(--gold-faint)', color: 'var(--gold)', borderColor: 'rgba(197, 137, 64, 0.24)' }
      : { background: 'var(--bg-base)', color: 'var(--text-muted)', borderColor: 'var(--border-muted)' };

  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium border"
      style={styles}
    >
      {label}
    </span>
  );
}

export default function ProtocolExportDashboard({ projectId, onBackToProtocol, onGoToSearch }: Props) {
  const [protocol, setProtocol] = useState<SRProtocol | null>(null);
  const [prismaP, setPrismaP] = useState<PrismaPData | null>(null);
  const [adminDraft, setAdminDraft] = useState<PrismaPAdministrative | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<BusyAction>('idle');
  const [status, setStatus] = useState('');
  const [metaSaving, setMetaSaving] = useState(false);
  const [osfToken, setOsfToken] = useState('');
  const [osfResult, setOsfResult] = useState<Record<string, string> | null>(null);
  const generateAbortRef = useRef<AbortController | null>(null);

  const refreshData = useCallback(async () => {
    const [protocolResult, prismaResult] = await Promise.all([
      getProtocol(projectId),
      getPrismaP(projectId),
    ]);
    setProtocol(protocolResult);
    setPrismaP(prismaResult.prisma_p);
    setAdminDraft(buildAdministrativeDraft(prismaResult.prisma_p, protocolResult));
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');

    refreshData()
      .catch((error) => {
        if (!cancelled) setLoadError(String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      generateAbortRef.current?.abort();
    };
  }, [refreshData]);

  const reviewTitle = useMemo(() => extractTitle(protocol, prismaP), [protocol, prismaP]);
  const exportTitle = adminDraft?.review_title?.trim() || reviewTitle;
  const isProtocolReady = Boolean(protocol?.protocol_document);
  const prosperoFields = protocol?.prospero_fields || {};
  const prosperoText = useMemo(() => buildProsperoText(prosperoFields), [prosperoFields]);
  const selectedRegistries = protocol?.pico?.target_registries || [];
  const checklistCount = Object.keys(protocol?.prisma_p_checklist || {}).length;
  const searchStrategyCount = Object.keys(protocol?.search_strategies || {}).length;
  const protocolPreview = protocol?.protocol_document?.split('\n').slice(0, 18).join('\n') || '';
  const adminDraftPayload = JSON.stringify(adminDraft || {});
  const savedAdminPayload = JSON.stringify(buildAdministrativeDraft(prismaP, protocol));
  const adminDirty = adminDraftPayload !== savedAdminPayload;

  const persistAdministrative = useCallback(async (announce = false) => {
    if (!adminDraft) return;
    setMetaSaving(true);
    try {
      await savePrismaP(projectId, 'administrative', adminDraft);
      setPrismaP((prev) => ({ ...(prev || {}), administrative: adminDraft }));
      if (announce) setStatus('Export metadata saved.');
    } catch (error) {
      setStatus(`Could not save export metadata: ${String(error)}`);
      throw error;
    } finally {
      setMetaSaving(false);
    }
  }, [adminDraft, projectId]);

  const handleGenerate = useCallback(async () => {
    setBusy('generate');
    setStatus('Generating protocol manuscript from the latest saved protocol steps...');
    try {
      await persistAdministrative();
      await new Promise<void>((resolve, reject) => {
        let streamError = '';
        generateAbortRef.current?.abort();
        generateAbortRef.current = streamGenerateProtocolFetch(
          projectId,
          (event) => {
            if (typeof event.message === 'string') setStatus(event.message);
            if (event.type === 'error') {
              streamError = String(event.message || 'Protocol generation failed.');
            }
          },
          () => {
            generateAbortRef.current = null;
            if (streamError) reject(new Error(streamError));
            else resolve();
          },
          (error) => {
            generateAbortRef.current = null;
            reject(new Error(error));
          },
        );
      });

      await refreshData();
      setStatus('Protocol manuscript generated. PRISMA-P export now uses page numbers from this manuscript.');
    } catch (error) {
      setStatus(`Generation failed: ${String(error)}`);
    } finally {
      setBusy('idle');
    }
  }, [persistAdministrative, projectId, refreshData]);

  const ensureProtocolReady = useCallback(async () => {
    if (protocol?.protocol_document) return true;
    await handleGenerate();
    return Boolean((await getProtocol(projectId)).protocol_document);
  }, [handleGenerate, projectId, protocol]);

  const handleDownload = useCallback(async (kind: 'protocol' | 'prisma') => {
    setBusy(kind);
    setStatus(kind === 'protocol' ? 'Preparing protocol Word export...' : 'Preparing PRISMA-P Word export...');
    try {
      await persistAdministrative();
      const ready = await ensureProtocolReady();
      if (!ready) throw new Error('Generate the protocol manuscript first.');

      if (kind === 'protocol') {
        await downloadProtocolDocx(projectId);
        setStatus('Protocol manuscript Word file downloaded.');
      } else {
        await downloadPrismaPChecklistDocx(projectId);
        setStatus('PRISMA-P checklist Word file downloaded with page-number references.');
      }
    } catch (error) {
      setStatus(`Export failed: ${String(error)}`);
    } finally {
      setBusy('idle');
    }
  }, [ensureProtocolReady, persistAdministrative, projectId]);

  const handleRegisterOSF = useCallback(async () => {
    if (!osfToken.trim()) {
      setStatus('Enter an OSF token before starting automatic OSF registration.');
      return;
    }

    setBusy('osf');
    setStatus('Creating an OSF draft registration from the generated protocol...');
    try {
      await persistAdministrative();
      const ready = await ensureProtocolReady();
      if (!ready) throw new Error('Generate the protocol manuscript first.');

      const result = await registerOSF(projectId, osfToken.trim());
      setOsfResult(result);
      await refreshData();
      setStatus(result.message || 'OSF draft registration created.');
    } catch (error) {
      setStatus(`OSF registration failed: ${String(error)}`);
    } finally {
      setBusy('idle');
    }
  }, [ensureProtocolReady, osfToken, persistAdministrative, projectId, refreshData]);

  const handleCopyProspero = useCallback(async () => {
    if (!prosperoText) {
      setStatus('Generate the protocol manuscript first to populate PROSPERO fields.');
      return;
    }
    try {
      await navigator.clipboard.writeText(prosperoText);
      setStatus('PROSPERO field pack copied to clipboard.');
    } catch (error) {
      setStatus(`Could not copy PROSPERO fields: ${String(error)}`);
    }
  }, [prosperoText]);

  return (
    <div className="mx-auto px-4 py-6 space-y-6">
      <div
        className="rounded-2xl border p-5 md:p-6"
        style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip label="Protocol Export Hub" tone="gold" />
              <StatusChip label={isProtocolReady ? 'Protocol generated' : 'Protocol pending'} tone={isProtocolReady ? 'success' : 'neutral'} />
              <StatusChip label={protocol?.registration_status ? `Registration: ${protocol.registration_status}` : 'Registration not started'} />
            </div>
            <div>
              <h1
                className="text-3xl font-semibold leading-tight"
                style={{ fontFamily: 'Newsreader, Georgia, serif', color: 'var(--text-heading)' }}
              >
                {exportTitle}
              </h1>
              <p className="mt-2 text-sm max-w-3xl" style={{ color: 'var(--text-muted)' }}>
                All protocol-builder steps are already saved to the database. Generate the manuscript here, then export the
                protocol files or prepare OSF, PROSPERO, journal, and preprint submissions from the saved record.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={onBackToProtocol}
              className="px-4 py-2 text-sm rounded-xl border transition-colors"
              style={{ borderColor: 'var(--border-muted)', color: 'var(--text-muted)', background: 'transparent' }}
            >
              Back to Protocol
            </button>
            <button
              onClick={onGoToSearch}
              className="px-4 py-2 text-sm rounded-xl border transition-colors"
              style={{ borderColor: 'var(--gold)', color: 'var(--gold)', background: 'var(--gold-faint)' }}
            >
              Continue to Search
            </button>
          </div>
        </div>
      </div>

      {status && (
        <div
          className="rounded-xl border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)', color: 'var(--text-muted)' }}
        >
          {status}
        </div>
      )}

      {loadError && (
        <div
          className="rounded-xl border px-4 py-3 text-sm flex items-center justify-between gap-3"
          style={{ borderColor: 'rgba(220, 38, 38, 0.24)', background: 'rgba(220, 38, 38, 0.06)', color: '#b91c1c' }}
        >
          <span>{loadError}</span>
          <button
            onClick={() => {
              setLoading(true);
              setLoadError('');
              refreshData().catch((error) => setLoadError(String(error))).finally(() => setLoading(false));
            }}
            className="px-3 py-1.5 rounded-lg border text-xs"
            style={{ borderColor: 'rgba(220, 38, 38, 0.24)' }}
          >
            Retry
          </button>
        </div>
      )}

      {adminDraft && (
        <section
          className="rounded-2xl border p-5 space-y-4"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
        >
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-heading)' }}>Export Metadata</h2>
              <p className="mt-1 text-sm max-w-3xl" style={{ color: 'var(--text-muted)' }}>
                Finalize title, registry choice, funding, conflicts, and amendment language here. These values are saved to the database and used when you generate or export the protocol manuscript.
              </p>
            </div>
            <button
              onClick={() => { persistAdministrative(true).catch(() => undefined); }}
              disabled={metaSaving || !adminDirty}
              className="px-4 py-2 rounded-xl text-sm font-medium border disabled:opacity-50"
              style={{ borderColor: 'var(--border-muted)', color: 'var(--text-heading)', background: 'transparent' }}
            >
              {metaSaving ? 'Saving...' : adminDirty ? 'Save Metadata' : 'Saved'}
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Protocol Title
              </label>
              <input
                value={adminDraft.review_title || ''}
                onChange={(event) => setAdminDraft((prev) => ({ ...(prev || {}), review_title: event.target.value }))}
                className="mt-2 w-full rounded-xl border px-3 py-2.5 text-sm"
                style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Registry / Submission Target
              </label>
              <input
                value={adminDraft.registration_name || ''}
                onChange={(event) => setAdminDraft((prev) => ({ ...(prev || {}), registration_name: event.target.value }))}
                placeholder="PROSPERO, OSF, journal submission, preprint, or leave blank"
                className="mt-2 w-full rounded-xl border px-3 py-2.5 text-sm"
                style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Registration ID
              </label>
              <input
                value={adminDraft.registration_number || ''}
                onChange={(event) => setAdminDraft((prev) => ({ ...(prev || {}), registration_number: event.target.value }))}
                placeholder="Optional until a registry or server assigns one"
                className="mt-2 w-full rounded-xl border px-3 py-2.5 text-sm"
                style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Author Contributions
              </label>
              <input
                value={adminDraft.contributions || ''}
                onChange={(event) => setAdminDraft((prev) => ({ ...(prev || {}), contributions: event.target.value }))}
                placeholder="Optional. Finalize here before journal or registry submission."
                className="mt-2 w-full rounded-xl border px-3 py-2.5 text-sm"
                style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Funding
              </label>
              <textarea
                value={adminDraft.funding_sources || ''}
                onChange={(event) => setAdminDraft((prev) => ({ ...(prev || {}), funding_sources: event.target.value }))}
                rows={3}
                className="mt-2 w-full rounded-xl border px-3 py-3 text-sm leading-6"
                style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Competing Interests
              </label>
              <textarea
                value={adminDraft.competing_interests || ''}
                onChange={(event) => setAdminDraft((prev) => ({ ...(prev || {}), competing_interests: event.target.value }))}
                rows={3}
                className="mt-2 w-full rounded-xl border px-3 py-3 text-sm leading-6"
                style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Amendment Policy
            </label>
            <textarea
              value={adminDraft.amendment_plan || ''}
              onChange={(event) => setAdminDraft((prev) => ({ ...(prev || {}), amendment_plan: event.target.value }))}
              rows={3}
              className="mt-2 w-full rounded-xl border px-3 py-3 text-sm leading-6"
              style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
            />
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <section
          className="rounded-2xl border p-5 space-y-4"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
        >
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-heading)' }}>Protocol Files</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              Generate the protocol manuscript once from the saved builder data, then export the protocol and checklist files.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <StatusChip label={`${checklistCount || 0} checklist items`} />
            <StatusChip label={`${searchStrategyCount || 0} search strategies`} />
          </div>

          <button
            onClick={handleGenerate}
            disabled={loading || metaSaving || busy !== 'idle'}
            className="w-full px-4 py-3 rounded-xl text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--gold)', color: '#fff' }}
          >
            {busy === 'generate' ? 'Generating...' : isProtocolReady ? 'Regenerate Protocol Manuscript' : 'Generate Protocol Manuscript'}
          </button>

          <button
            onClick={() => handleDownload('protocol')}
            disabled={loading || metaSaving || busy !== 'idle'}
            className="w-full px-4 py-3 rounded-xl text-sm font-medium border disabled:opacity-50"
            style={{ borderColor: 'var(--border-muted)', color: 'var(--text-heading)', background: 'transparent' }}
          >
            {busy === 'protocol' ? 'Preparing...' : 'Download Protocol DOCX'}
          </button>

          <button
            onClick={() => handleDownload('prisma')}
            disabled={loading || metaSaving || busy !== 'idle'}
            className="w-full px-4 py-3 rounded-xl text-sm font-medium border disabled:opacity-50"
            style={{ borderColor: 'var(--border-muted)', color: 'var(--text-heading)', background: 'transparent' }}
          >
            {busy === 'prisma' ? 'Preparing...' : 'Download PRISMA-P DOCX'}
          </button>

          <p className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
            The PRISMA-P Word export is generated after the protocol manuscript and includes the reported page-number column.
          </p>
        </section>

        <section
          className="rounded-2xl border p-5 space-y-4"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
        >
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-heading)' }}>Registration and Approval</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              Use the generated manuscript for OSF registration and the mapped PROSPERO field pack for manual registry submission.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              OSF Personal Token
            </label>
            <input
              type="password"
              value={osfToken}
              onChange={(event) => setOsfToken(event.target.value)}
              placeholder="Paste OSF token for automatic draft registration"
              className="w-full rounded-xl border px-3 py-2.5 text-sm"
              style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
            />
          </div>

          <button
            onClick={handleRegisterOSF}
            disabled={loading || metaSaving || busy !== 'idle'}
            className="w-full px-4 py-3 rounded-xl text-sm font-medium border disabled:opacity-50"
            style={{ borderColor: 'var(--border-muted)', color: 'var(--text-heading)', background: 'transparent' }}
          >
            {busy === 'osf' ? 'Registering...' : 'Create OSF Draft Registration'}
          </button>

          <div className="flex flex-wrap gap-2">
            <a
              href={PROSPERO_URL}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-2 rounded-lg text-xs font-medium border"
              style={{ borderColor: 'var(--border-muted)', color: 'var(--text-heading)' }}
            >
              Open PROSPERO
            </a>
            <a
              href={OSF_REGISTRIES_URL}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-2 rounded-lg text-xs font-medium border"
              style={{ borderColor: 'var(--border-muted)', color: 'var(--text-heading)' }}
            >
              Open OSF Registries
            </a>
          </div>

          {(osfResult?.url || protocol?.osf_registration_id) && (
            <div className="rounded-xl border px-3 py-3 text-sm space-y-1" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)' }}>
              <div style={{ color: 'var(--text-heading)', fontWeight: 600 }}>OSF status</div>
              {protocol?.osf_registration_id && (
                <div style={{ color: 'var(--text-muted)' }}>Saved OSF ID: {protocol.osf_registration_id}</div>
              )}
              {osfResult?.url && (
                <a href={osfResult.url} target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}>
                  {osfResult.url}
                </a>
              )}
            </div>
          )}
        </section>

        <section
          className="rounded-2xl border p-5 space-y-4"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
        >
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-heading)' }}>Submission Paths</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              Keep exports and registry submission here, then move to database searching after approvals or permissions are in place.
            </p>
          </div>

          <div className="space-y-3 text-sm" style={{ color: 'var(--text-muted)' }}>
            <div className="rounded-xl border px-3 py-3" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)' }}>
              <div style={{ color: 'var(--text-heading)', fontWeight: 600 }}>Protocol journal submission</div>
              <p className="mt-1">Use the protocol DOCX, cover letter, and any journal-specific approval forms before starting the review.</p>
            </div>
            <div className="rounded-xl border px-3 py-3" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)' }}>
              <div style={{ color: 'var(--text-heading)', fontWeight: 600 }}>Preprint server submission</div>
              <p className="mt-1">Use the same generated manuscript for medRxiv, OSF Preprints, Research Square, or similar protocol-friendly servers.</p>
            </div>
            <div className="rounded-xl border px-3 py-3" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)' }}>
              <div style={{ color: 'var(--text-heading)', fontWeight: 600 }}>Approvals and permissions</div>
              <p className="mt-1">Keep ethics approvals, sponsor permissions, registry IDs, and funder confirmations aligned with the protocol export set.</p>
            </div>
          </div>

          {selectedRegistries.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Selected registries from protocol setup
              </div>
              <div className="flex flex-wrap gap-2">
                {selectedRegistries.map((registry) => (
                  <StatusChip key={registry} label={titleCaseLabel(registry)} tone="gold" />
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <section
          className="rounded-2xl border p-5 space-y-4"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-heading)' }}>PROSPERO Field Pack</h2>
              <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                Manual PROSPERO submission still happens outside the app, but the generated field pack is ready for copy-paste.
              </p>
            </div>
            <button
              onClick={handleCopyProspero}
              className="px-3 py-2 rounded-lg text-xs font-medium border"
              style={{ borderColor: 'var(--border-muted)', color: 'var(--text-heading)' }}
            >
              Copy All Fields
            </button>
          </div>

          <textarea
            readOnly
            value={prosperoText || 'Generate the protocol manuscript to populate the PROSPERO field pack.'}
            rows={18}
            className="w-full rounded-xl border px-3 py-3 text-sm leading-6"
            style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
          />
        </section>

        <section
          className="rounded-2xl border p-5 space-y-4"
          style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-surface)' }}
        >
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-heading)' }}>Generated Snapshot</h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              Quick check of what is currently stored for export and registration.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border px-3 py-3" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)' }}>
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Status</div>
              <div className="mt-1 text-sm font-medium" style={{ color: 'var(--text-heading)' }}>{loading ? 'Loading...' : (isProtocolReady ? 'Ready for export' : 'Generate first')}</div>
            </div>
            <div className="rounded-xl border px-3 py-3" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)' }}>
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Registry fields</div>
              <div className="mt-1 text-sm font-medium" style={{ color: 'var(--text-heading)' }}>{Object.keys(prosperoFields).length}</div>
            </div>
            <div className="rounded-xl border px-3 py-3" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)' }}>
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>PRISMA-P items</div>
              <div className="mt-1 text-sm font-medium" style={{ color: 'var(--text-heading)' }}>{checklistCount}</div>
            </div>
            <div className="rounded-xl border px-3 py-3" style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)' }}>
              <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Search strings</div>
              <div className="mt-1 text-sm font-medium" style={{ color: 'var(--text-heading)' }}>{searchStrategyCount}</div>
            </div>
          </div>

          <pre
            className="rounded-xl border p-3 text-xs overflow-auto whitespace-pre-wrap"
            style={{ borderColor: 'var(--border-muted)', background: 'var(--bg-base)', color: 'var(--text-body)' }}
          >
            {protocolPreview || 'No generated protocol manuscript is stored yet.'}
          </pre>
        </section>
      </div>
    </div>
  );
}
