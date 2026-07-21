// store.test.ts — dialogue-only chat routing (task P-B item 4, feedback:
// "less content in chat and more on the board"). `commit`'s `say` branch now
// only appends to `chat` when `activeTurnKind === 'chat'` — a tutor reply to
// a student's typed question belongs in the transcript; narration during a
// teach/event/answer turn is caption-only (unconditional — timeline.ts's
// `runSay` -> `setCaption` isn't touched by this at all, so it isn't
// re-tested here; see app.test.tsx for App.tsx's `setActiveTurnKind`
// wiring around `streamTurn`, the other half of this feature).
//
// Exercises `commit` directly (bypassing enqueue/timeline entirely) so this
// stays a fast, timer-free unit test of the store's own gating logic.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Action, emptyScene } from '@board/shared'
import { readFramesModeLS, readVoiceOnLS, selectTranscript, useBoard } from '../src/store'
import { BrowserTts, setTtsProvider, type TtsProvider } from '../src/tts'

beforeEach(() => {
  useBoard.setState({
    scene: emptyScene,
    history: [],
    steps: [],
    chat: [],
    ask: null,
    caption: '',
    selection: null,
    activeTurnKind: null,
  })
})

describe('dialogue-only chat: commit() gates `say` -> chat by activeTurnKind', () => {
  it('a say during a chat-kind turn appends to the chat transcript', () => {
    useBoard.getState().setActiveTurnKind('chat')
    useBoard.getState().commit({ op: 'say', text: 'a parabola opens upward when a > 0' })

    expect(useBoard.getState().chat).toEqual([
      { from: 'teacher', text: 'a parabola opens upward when a > 0' },
    ])
  })

  it('a say during a non-chat (teach/event/answer) turn does NOT append to chat', () => {
    useBoard.getState().setActiveTurnKind('other')
    useBoard.getState().commit({ op: 'say', text: "let's plot x squared" })

    expect(useBoard.getState().chat).toEqual([])
  })

  it('a say before any turn has ever run (activeTurnKind still null) does NOT append to chat', () => {
    useBoard.getState().commit({ op: 'say', text: 'narrating before any turn kind is set' })

    expect(useBoard.getState().chat).toEqual([])
  })

  it('still records every say in history regardless of routing (replay is unaffected)', () => {
    useBoard.getState().setActiveTurnKind('other')
    useBoard.getState().commit({ op: 'say', text: 'caption-only narration' })

    expect(useBoard.getState().history).toEqual([{ op: 'say', text: 'caption-only narration' }])
  })

  it('routes each say independently as activeTurnKind flips between turns', () => {
    useBoard.getState().setActiveTurnKind('other')
    useBoard.getState().commit({ op: 'say', text: 'narration one' })

    useBoard.getState().setActiveTurnKind('chat')
    useBoard.getState().commit({ op: 'say', text: 'reply to student' })

    useBoard.getState().setActiveTurnKind('other')
    useBoard.getState().commit({ op: 'say', text: 'narration two' })

    expect(useBoard.getState().chat).toEqual([{ from: 'teacher', text: 'reply to student' }])
    expect(useBoard.getState().history).toHaveLength(3) // all three still land in the replay log
  })

  it('an ask/step commit is unaffected by activeTurnKind (only say is gated)', () => {
    useBoard.getState().setActiveTurnKind('other')
    useBoard.getState().commit({ op: 'step', title: 'Intro' })
    useBoard.getState().commit({ op: 'ask', id: 'q1', kind: 'mcq', text: 'x or y?', options: ['x', 'y'] })

    expect(useBoard.getState().steps).toEqual([{ title: 'Intro', startIndex: 0 }])
    expect(useBoard.getState().ask).toEqual({
      id: 'q1',
      kind: 'mcq',
      text: 'x or y?',
      options: ['x', 'y'],
      answer: undefined,
    })
  })
})

describe('reset() clears activeTurnKind back to null', () => {
  it('clears a previously-set activeTurnKind', () => {
    useBoard.getState().setActiveTurnKind('chat')
    useBoard.getState().reset()

    expect(useBoard.getState().activeTurnKind).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// selectTranscript (task D-2, feedback: "it should store whatever text it
// has shown in the right chat bar, for us to reference") -- a pure
// derivation over `history`, grouping every `say`'s text under the most
// recent `step`'s title. Exercised directly (not via commit/history state)
// since it's a plain function of an Action[], independent of the store.
// ---------------------------------------------------------------------------
describe('selectTranscript: history -> grouped narration transcript', () => {
  it('empty history -> no groups', () => {
    expect(selectTranscript([])).toEqual([])
  })

  it('groups says under the most recent step title', () => {
    const history: Action[] = [
      { op: 'step', title: 'Intro to parabolas' },
      { op: 'say', text: 'a parabola is a U-shaped curve' },
      { op: 'add', c: 'axes', id: 'ax1', xmin: -5, xmax: 5, ymin: -5, ymax: 5 },
      { op: 'say', text: 'here is the x^2 curve' },
      { op: 'step', title: 'Vertex' },
      { op: 'say', text: 'the vertex is the turning point' },
    ]
    expect(selectTranscript(history)).toEqual([
      { title: 'Intro to parabolas', lines: ['a parabola is a U-shaped curve', 'here is the x^2 curve'] },
      { title: 'Vertex', lines: ['the vertex is the turning point'] },
    ])
  })

  it('says before any step land in an untitled leading group', () => {
    const history: Action[] = [
      { op: 'say', text: 'freeform narration with no beat/step yet' },
      { op: 'step', title: 'First beat' },
      { op: 'say', text: 'now inside a beat' },
    ]
    expect(selectTranscript(history)).toEqual([
      { title: '', lines: ['freeform narration with no beat/step yet'] },
      { title: 'First beat', lines: ['now inside a beat'] },
    ])
  })

  it('a step with no says under it yet is dropped (no empty section headers)', () => {
    const history: Action[] = [
      { op: 'step', title: 'Intro' },
      { op: 'say', text: 'said something' },
      { op: 'step', title: 'Not narrated yet' },
    ]
    expect(selectTranscript(history)).toEqual([{ title: 'Intro', lines: ['said something'] }])
  })

  it('non-say/step actions (add/set/ask/...) are ignored, not just skipped-but-counted', () => {
    const history: Action[] = [
      { op: 'step', title: 'Beat' },
      { op: 'set', id: 'p1', k: 'deg', v: 45 },
      { op: 'ask', id: 'q1', kind: 'mcq', text: 'x or y?', options: ['x', 'y'] },
      { op: 'say', text: 'only this line shows up' },
    ]
    expect(selectTranscript(history)).toEqual([{ title: 'Beat', lines: ['only this line shows up'] }])
  })
})

// ---------------------------------------------------------------------------
// Frames mode + voice narration (V-1): localStorage persistence. Tests the
// read helpers directly (no module-reload gymnastics needed) plus the
// toggle actions' write path against jsdom's real localStorage.
// ---------------------------------------------------------------------------
describe('V-1 preferences: localStorage persistence', () => {
  afterEach(() => {
    localStorage.removeItem('board.framesMode')
    localStorage.removeItem('board.voiceOn')
  })

  it('readFramesModeLS defaults to false with nothing stored', () => {
    localStorage.removeItem('board.framesMode')
    expect(readFramesModeLS()).toBe(false)
  })

  it('readFramesModeLS reflects a stored value', () => {
    localStorage.setItem('board.framesMode', 'true')
    expect(readFramesModeLS()).toBe(true)
    localStorage.setItem('board.framesMode', 'false')
    expect(readFramesModeLS()).toBe(false)
  })

  it('readVoiceOnLS defaults to false with nothing stored', () => {
    localStorage.removeItem('board.voiceOn')
    expect(readVoiceOnLS()).toBe(false)
  })

  it('toggleFramesMode flips state and persists the new value to localStorage', () => {
    useBoard.setState({ framesMode: false })
    useBoard.getState().toggleFramesMode()
    expect(useBoard.getState().framesMode).toBe(true)
    expect(localStorage.getItem('board.framesMode')).toBe('true')

    useBoard.getState().toggleFramesMode()
    expect(useBoard.getState().framesMode).toBe(false)
    expect(localStorage.getItem('board.framesMode')).toBe('false')
  })

  it('toggleVoice flips state and persists the new value to localStorage', () => {
    useBoard.setState({ voiceOn: false })
    useBoard.getState().toggleVoice()
    expect(useBoard.getState().voiceOn).toBe(true)
    expect(localStorage.getItem('board.voiceOn')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// Caption ghost (V-1): store-level half of the reading-pace feature.
// ---------------------------------------------------------------------------
describe('caption ghost (V-1): beginSay + reset points', () => {
  beforeEach(() => {
    useBoard.setState({ scene: emptyScene, history: [], steps: [], caption: '', captionPrev: '', frameSnapshots: [] })
  })

  it('beginSay snapshots the outgoing caption into captionPrev and clears caption', () => {
    useBoard.setState({ caption: 'the old line' })
    useBoard.getState().beginSay()
    expect(useBoard.getState().captionPrev).toBe('the old line')
    expect(useBoard.getState().caption).toBe('')
  })

  it('jumpToStep resets caption, captionPrev, and frameSnapshots', () => {
    useBoard.getState().commit({ op: 'step', title: 'intro' })
    useBoard.setState({
      caption: 'mid-say text',
      captionPrev: 'a previous line',
      frameSnapshots: [{ elId: 'p1', k: 'x', values: [0, 1, 2, 3] }],
    })

    useBoard.getState().jumpToStep(0)

    expect(useBoard.getState().caption).toBe('')
    expect(useBoard.getState().captionPrev).toBe('')
    expect(useBoard.getState().frameSnapshots).toEqual([])
  })

  it('reset() clears captionPrev and frameSnapshots, but leaves framesMode/voiceOn (persisted prefs) untouched', () => {
    useBoard.setState({
      captionPrev: 'a previous line',
      frameSnapshots: [{ elId: 'p1', k: 'x', values: [0, 1, 2, 3] }],
      framesMode: true,
      voiceOn: true,
    })

    useBoard.getState().reset()

    expect(useBoard.getState().captionPrev).toBe('')
    expect(useBoard.getState().frameSnapshots).toEqual([])
    expect(useBoard.getState().framesMode).toBe(true) // unaffected — a persisted preference, not session state
    expect(useBoard.getState().voiceOn).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Voice narration (V-1): store-level pause()/play() <-> ttsProvider wiring.
// ---------------------------------------------------------------------------
describe('voice narration (V-1): pause()/play() drive ttsProvider.pause()/resume()', () => {
  let fake: TtsProvider & { pauseCalls: number; resumeCalls: number; cancelCalls: number }

  beforeEach(() => {
    fake = {
      pauseCalls: 0,
      resumeCalls: 0,
      cancelCalls: 0,
      available: () => true,
      speak: () => Promise.resolve(),
      cancel() {
        this.cancelCalls++
      },
      pause() {
        this.pauseCalls++
      },
      resume() {
        this.resumeCalls++
      },
    }
    setTtsProvider(fake)
    useBoard.setState({ playing: true, voiceOn: true })
  })

  afterEach(() => {
    setTtsProvider(new BrowserTts())
  })

  it('pause() calls ttsProvider.pause() when voice is on', () => {
    useBoard.getState().pause()
    expect(fake.pauseCalls).toBe(1)
  })

  it('play() calls ttsProvider.resume() when voice is on', () => {
    useBoard.getState().play()
    expect(fake.resumeCalls).toBe(1)
  })

  it('pause()/play() never touch the provider when voice is off', () => {
    useBoard.setState({ voiceOn: false })
    useBoard.getState().pause()
    useBoard.getState().play()
    expect(fake.pauseCalls).toBe(0)
    expect(fake.resumeCalls).toBe(0)
  })

  it('toggleVoice(off) cancels any in-flight speech immediately', () => {
    useBoard.setState({ voiceOn: true })
    useBoard.getState().toggleVoice()
    expect(fake.cancelCalls).toBe(1)
    expect(useBoard.getState().voiceOn).toBe(false)
  })
})
