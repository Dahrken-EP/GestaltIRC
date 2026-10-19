// Hosting files on the bouncer, for the attach button. The bouncer's operator chooses the
// limits, and this module holds what it allows, fetched once: the button only shows when
// uploads are switched on, and the client warns about the size before sending anything.

import { api, type UploadInfo } from './api'

let state = $state<{ info: UploadInfo | null }>({ info: null })
let loading: Promise<void> | null = null

/** Whether uploads are on here. False until the bouncer answers, and when they are off. */
export function uploadsEnabled(): boolean {
  return state.info?.enabled === true
}

/** The limits, once known. Null while fetching or when uploads are off. */
export function uploadLimits(): UploadInfo | null {
  return uploadsEnabled() ? state.info : null
}

/**
 * Asks the bouncer once what it allows. Safe to call from anywhere, any number of times:
 * later calls reuse the first answer. A bouncer that does not serve this endpoint (an
 * older release, or a guest page before login) keeps the button hidden.
 */
export function ensureUploadInfo(): Promise<void> {
  if (state.info || loading) return loading ?? Promise.resolve()
  loading = api
    .uploadInfo()
    .then((info) => {
      state.info = info
    })
    .catch(() => {
      // 404 on an older bouncer, 401 on a guest page, or the bouncer offline.
      state.info = { enabled: false, max_bytes: 0, max_days: 0 }
    })
    .finally(() => {
      loading = null
    })
  return loading
}

/** True while a check is in flight, so the button does not flash on. */
export function uploadInfoPending(): boolean {
  return loading !== null && state.info === null
}
