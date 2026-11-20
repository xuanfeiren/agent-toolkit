export type BoardLesson = {
  id: string
  writer: string
  cand: string
  minute: number
  /** verified | partly_verified | unverified | refuted | withheld | pending | unchecked | gain | nogain */
  status: string
  note: string
  isPushed: boolean
  deliveredTo: string[]
  /** Lesson this one corrects, or ''. */
  corrects: string
  /** Ids of visible lessons that correct this one. */
  correctedBy: string[]
  text: string
}

export type BoardRun = {
  runId: string
  task: string
  n: number
  /** open | closed:<reason> | confirmed */
  state: string
  minute: number
  settings: string
  rejected: number
  rejectedForCopy: number
  winner: string
  lessons: BoardLesson[]
}

export type BoardView = { filter: 'all' | 'verified' | 'pending'; isNewestFirst: boolean }

declare module 'claude-code' {
  interface PluginState {
    lessonshare: { run: Shaped<BoardRun | null>; view: Shaped<BoardView> }
  }
}
