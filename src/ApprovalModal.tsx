import { useEffect, useRef } from "react";
import { ShieldCheck, X, LoaderCircle, ArrowRight } from "lucide-react";
import { getStore, money } from "../shared/catalog";
import type { RunResult } from "../shared/types";
import { StoreMark } from "./components";
export default function ApprovalModal({
  result,
  acknowledged,
  setAcknowledged,
  approving,
  error,
  approve,
  close,
}: {
  result: RunResult;
  acknowledged: boolean;
  setAcknowledged: (b: boolean) => void;
  approving: boolean;
  error: string | null;
  approve: () => void;
  close: () => void;
}) {
  const quote = result.winner!;
  const firstButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    firstButton.current?.focus();
  }, []);
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="modal approval-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Approve your sandbox order"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div className="approval-icon">
            <ShieldCheck size={24} />
          </div>
          <button
            ref={firstButton}
            className="icon-button"
            disabled={approving}
            aria-label="Close approval"
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        <div className="eyebrow">YOU HAVE THE FINAL SAY</div>
        <h2>Ready to call it done?</h2>
        <p>Review your basket before Cerebras places the sandbox order.</p>
        <div className="approval-store">
          <StoreMark store={quote.store} />
          <div>
            <strong>{getStore(quote.store).shortName}</strong>
            <span>{quote.slot?.label}</span>
          </div>
        </div>
        <div className="approval-items">
          {quote.items.map((item) => (
            <div key={item.product.id}>
              <span>
                {item.quantity} × {item.product.name}
              </span>
              <strong>{money(item.product.price * item.quantity)}</strong>
            </div>
          ))}
        </div>
        <div className="approval-bill">
          <div>
            <span>Delivery</span>
            <span>{money(quote.delivery)}</span>
          </div>
          <div>
            <span>Tax · demo groceries</span>
            <span>$0.00</span>
          </div>
          <div className="approval-total">
            <span>Total</span>
            <strong>{money(quote.total)}</strong>
          </div>
        </div>
        <label className="approval-checkbox">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            disabled={approving}
          />
          <span>
            I approve this sandbox order for{" "}
            <strong>{money(quote.total)}</strong>. No money will be charged and
            no real delivery will be made.
          </span>
        </label>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <button
          className="primary-button approve-final"
          disabled={!acknowledged || approving}
          onClick={approve}
        >
          {approving ? (
            <>
              <LoaderCircle size={16} className="spin" /> Placing sandbox order…
            </>
          ) : (
            <>
              Approve sandbox order · {money(quote.total)}
              <ArrowRight size={16} />
            </>
          )}
        </button>
        <button className="text-button" onClick={close} disabled={approving}>
          Back to my basket
        </button>
      </section>
    </div>
  );
}
