import type { Status } from './types.js'

/** unavailable < estimated < confirmed。合并取最弱者，缺失向上传染。 */
const RANK: Record<Status, number> = { unavailable: 0, estimated: 1, confirmed: 2 }

export function weakest(...xs: Status[]): Status {
  if (xs.length === 0) return 'unavailable'
  return xs.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b))
}

export const STATUS_LABEL: Record<Status, string> = {
  confirmed: '已确认',
  estimated: '估算',
  unavailable: '待确认',
}
