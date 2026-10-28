import { useEffect, useRef, useState } from 'react'
import { readLocalRounds, roundMessage, syncClosedRounds, writeDraft, type CartLine, type CheckoutFields, type ClosedRound, type RoundDraft } from './shopping-rounds'

export function useShoppingRounds(accountId: string | null, apiOrigin: string, online: boolean, onSynced: () => void) {
  const [state, setState] = useState<{ account: string | null; draft: RoundDraft | null; closed: ClosedRound[] }>({ account: null, draft: null, closed: [] })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [syncing, setSyncing] = useState<string | null>(null)
  const account = useRef(accountId), mounted = useRef(true), writing = useRef(false), syncingAccounts = useRef(new Set<string>()), changed = useRef(onSynced)
  account.current = accountId; changed.current = onSynced
  async function refresh(id = accountId) {
    if (!id) return
    try { const data = await readLocalRounds(id); if (mounted.current && account.current === id) { setState({ account: id, ...data }); setError('') } }
    catch (e) { if (mounted.current && account.current === id) setError(roundMessage(e instanceof Error ? e.message : 'ROUND_STORAGE_UNAVAILABLE')) }
  }
  async function sync() {
    const id = accountId
    if (!id || !online || syncingAccounts.current.has(id)) return
    syncingAccounts.current.add(id); setSyncing(id)
    try { const count = await syncClosedRounds(id, apiOrigin); if (count > 0 && mounted.current && account.current === id) changed.current(); await refresh(id) }
    catch (e) { if (mounted.current && account.current === id) { changed.current(); await refresh(id); setError(roundMessage(e instanceof Error ? e.message : '')) } }
    finally { syncingAccounts.current.delete(id); if (mounted.current && account.current === id) setSyncing(null) }
  }
  const draft = state.account === accountId ? state.draft : null
  const closed = state.account === accountId ? state.closed : []
  async function save(lines: CartLine[], checkout?: CheckoutFields) {
    const id = accountId
    if (!id || writing.current || state.account !== id) throw new Error('ROUND_STORAGE_UNAVAILABLE')
    writing.current = true; setBusy(true); setError('')
    try {
      await writeDraft(id, draft, lines, checkout)
      await refresh(id)
      if (checkout && online) void sync()
    } catch (e) { await refresh(id); if (mounted.current && account.current === id) setError(roundMessage(e instanceof Error ? e.message : '')); throw e }
    finally { writing.current = false; if (mounted.current) setBusy(false) }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    setState({ account: null, draft: null, closed: [] }); setError('')
    if (accountId) void refresh(accountId)
  }, [accountId])
  useEffect(() => { if (accountId && online) void sync() }, [accountId, online])
  useEffect(() => {
    const reload = () => { void refresh(accountId) }
    const event = (e: Event) => { if ((e as CustomEvent).detail === accountId) reload() }
    window.addEventListener('focus', reload); window.addEventListener('smartcart-rounds-changed', event)
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('smartcart-rounds') : null
    if (channel) channel.onmessage = e => { if (e.data === accountId) reload() }
    return () => { window.removeEventListener('focus', reload); window.removeEventListener('smartcart-rounds-changed', event); channel?.close() }
  }, [accountId])
  return { draft, closed, error, busy, loading: Boolean(accountId) && state.account !== accountId, syncing: syncing === accountId && accountId !== null,
    pending: closed.filter(round => round.status === 'pending'), save, sync, refresh }
}
export type ShoppingRoundsController = ReturnType<typeof useShoppingRounds>
