/**
 * VisualEditModal — chat-based iterative editor for a generated visual.
 *
 * Layout: split pane — live preview (left) + chat history + input (right).
 * Each user message triggers an AI edit, re-renders the preview.
 * "Finalize & Insert" saves the final output and closes the modal.
 * "Reset to Original" restores the first generated version.
 * "Cancel" closes without saving changes.
 */
import { useState, useRef, useEffect } from 'react';
import type { VisualItem, VisualRecommendations } from '../../types/paper';
import { editVisual, finalizeVisual, visualImageUrl } from '../../api/projects';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  item: VisualItem;
  projectId: string;
  onClose: () => void;
  onUpdated: (recs: VisualRecommendations) => void;
}

export default function VisualEditModal({ item, projectId, onClose, onUpdated }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: `Here is your ${item.type === 'table' ? 'table' : 'figure'}. What would you like to change?` },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentItem, setCurrentItem] = useState<VisualItem>(item);
  const [originalGen] = useState(item.generated);
  const [captionDraft, setCaptionDraft] = useState(item.generated?.caption ?? '');
  const [finalizing, setFinalizing] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const msg = input.trim();
    if (!msg || loading) return;
    setInput('');
    setError(null);

    const newMessages: ChatMessage[] = [...messages, { role: 'user', content: msg }];
    setMessages(newMessages);
    setLoading(true);

    try {
      const result = await editVisual(
        projectId,
        item.id,
        msg,
        newMessages.map(m => ({ role: m.role, content: m.content })),
        currentItem.generated?.source_code,
        currentItem.generated?.candidate_id ?? undefined,
      );

      const updatedItem = result.recs.items.find(i => i.id === item.id) ?? currentItem;
      setCurrentItem(updatedItem);
      onUpdated(result.recs);

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: result.explanation || 'Done. Here is the updated version.',
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Edit failed. Please try again.';
      setError(msg);
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${msg}` }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleReset = () => {
    if (!originalGen) return;
    setCurrentItem({ ...currentItem, generated: originalGen });
    setCaptionDraft(originalGen.caption ?? '');
    setMessages(prev => [...prev, { role: 'assistant', content: 'Reset to original version.' }]);
  };

  const handleFinalize = async () => {
    setFinalizing(true);
    try {
      const recs = await finalizeVisual(
        projectId,
        item.id,
        captionDraft || undefined,
        currentItem.generated?.candidate_id ?? undefined,
      );
      onUpdated(recs);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Finalize failed.';
      setError(msg);
    } finally {
      setFinalizing(false);
    }
  };

  const gen = currentItem.generated;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">
              Edit {currentItem.type === 'table' ? 'Table' : 'Figure'}: <span className="font-normal">{currentItem.title}</span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">Chat to refine · changes preview instantly</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">✕</button>
        </div>

        {/* Body: preview + chat */}
        <div className="flex flex-1 min-h-0">

          {/* Left: Live Preview */}
          <div className="w-1/2 border-r border-slate-200 flex flex-col min-h-0 p-4 overflow-auto bg-slate-50/50">
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Live Preview</p>
            {gen?.image_url && currentItem.type === 'figure' && (
              <img
                src={`${visualImageUrl(projectId, item.id)}?t=${Date.now()}`}
                alt={currentItem.title}
                className="max-w-full rounded border border-slate-200"
                style={{ maxHeight: '360px', objectFit: 'contain' }}
              />
            )}
            {gen?.table_html && currentItem.type === 'table' && (
              <div
                className="text-xs overflow-x-auto"
                dangerouslySetInnerHTML={{ __html: gen.table_html }}
              />
            )}
            {!gen && (
              <div className="flex items-center justify-center flex-1 text-slate-400 text-sm">
                No preview yet
              </div>
            )}

            {/* Caption editor */}
            <div className="mt-4">
              <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">
                Caption
              </label>
              <textarea
                value={captionDraft}
                onChange={e => setCaptionDraft(e.target.value)}
                rows={3}
                className="w-full text-xs border border-slate-200 rounded-md px-2 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder="Edit caption…"
              />
            </div>
          </div>

          {/* Right: Chat */}
          <div className="w-1/2 flex flex-col min-h-0">
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 text-slate-700'
                  }`}>
                    {m.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-slate-100 text-slate-500 rounded-lg px-3 py-2 text-xs flex items-center gap-2">
                    <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                    Editing…
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-slate-200 p-3 flex-shrink-0">
              {error && (
                <p className="text-xs text-rose-500 mb-2">{error}</p>
              )}
              <div className="flex gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Describe what to change… (Enter to send)"
                  rows={2}
                  className="flex-1 text-xs border border-slate-200 rounded-md px-2 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  disabled={loading}
                />
                <button
                  onClick={handleSend}
                  disabled={loading || !input.trim()}
                  className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-xs font-medium self-end transition-colors"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 bg-slate-50 flex-shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              className="px-3 py-1.5 rounded-md bg-white hover:bg-slate-100 text-slate-600 text-xs font-medium border border-slate-200 transition-colors"
            >
              Reset to Original
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md bg-white hover:bg-slate-100 text-slate-600 text-xs font-medium border border-slate-200 transition-colors"
            >
              Cancel
            </button>
          </div>
          <button
            onClick={handleFinalize}
            disabled={finalizing}
            className="px-4 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
          >
            {finalizing ? 'Finalizing…' : '✓ Finalize & Insert'}
          </button>
        </div>
      </div>
    </div>
  );
}
