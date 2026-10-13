// What the bot's admin commands need from the reconciler (spec 10, 7.1, 7.4). Implemented
// by src/reconcile/loop.ts; the bot only depends on this interface.

export interface ReconcileReport {
  node: string
  /** 'ok' | 'skipped' (already up to date) | 'error' */
  outcome: 'applied' | 'up-to-date' | 'error' | 'skipped'
  message?: string
}

export interface ReconcilerControl {
  /** Re-read config.yaml and reconcile every node now (/apply); `upgrade` also runs apt upgrade (/apply upgrade). Resolves when the cycle finishes. */
  applyNow(opts?: { upgrade?: boolean }): Promise<ReconcileReport[]>
  /** Accept a changed host key for a node's current address (/trust), then reconcile it. */
  trust(node: string): Promise<ReconcileReport[]>
  /** Regenerate obfuscation params (/rotate) and apply. */
  rotate(which: 'tunnel' | 'clients'): Promise<ReconcileReport[]>
}
