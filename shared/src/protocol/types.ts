// BoardEvent: client -> tutor events reporting student interaction with the board.
export type BoardEvent =
  | { ev: 'param'; id: string; k: string; from: number; to: number }
  | { ev: 'select'; id: string }
  | { ev: 'answer'; askId: string; value: string; correct: boolean | null }
  | { ev: 'nav'; action: 'replay' | 'back' | 'next'; step: number }
