/**
 * Browser half of dsh-topic-fold.
 *
 * Chat already folds the *process* of a completed Turn ("worked for 3m"), but
 * the answer stays on screen, so a long Session is still one wall of text when
 * you are looking for an earlier topic. This plugin adds one collapse control
 * per topic:
 *
 *   - `conversation.chat.user.before` puts a small chevron in the empty left
 *     margin of every prompt. Collapsing a topic hides every row of that Turn
 *     except its prompts, so the transcript reads as a list of topics.
 *   - `conversation.session.header.utilities` adds one button that collapses or
 *     expands every loaded topic at once.
 *
 * Collapse state is per Session and remembered in `localStorage`.
 *
 * How the hiding works, and why it is a stylesheet: a plugin can add rows but
 * cannot wrap the rows Chat owns. Chat tags each row wrapper with
 * `data-chat-turn` and `data-chat-flow-kind`, and the Conversation tags its
 * content host with `data-conversation-session`. One narrowly scoped rule per
 * collapsed topic therefore hides exactly that topic in exactly that Session.
 * Rules are rendered both by the header control (which is always mounted, so a
 * prompt whose own seat is claimed by another plugin still folds) and by the
 * topic's own control (so an embedded chat without a header still folds).
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-topic-fold',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace and the one storage key this plugin owns. */
    const NAMESPACE = 'topicFold'
    const STORAGE_KEY = 'dsh.topic-fold.v1'
    /** Keep in sync with package.json; logged so the running client is identifiable. */
    const VERSION = '0.2.1'
    /** Private context-menu target family for the transcript background. */
    const MENU_TARGET_KIND = 'topicFoldChat'
    /**
     * Inner elements that own their own right-click behavior. Everything else
     * inside a Conversation counts as empty space: row padding, the gaps
     * between rows, the gutters beside the column, and the band below the last
     * message all belong to containers, so a stricter row/Chat-region check
     * would reject exactly the places this menu exists for.
     */
    const BLANK_EXCLUSIONS = [
      'a', 'button', 'input', 'textarea', 'select', 'label', 'summary',
      'img', 'video', 'audio', 'canvas', 'pre', 'code',
      '[contenteditable="true"]', '[role="menu"]', '[role="button"]',
      '[data-context-menu]', '[data-composer-card]', '[data-composer-input]',
      '[data-text-interaction-source]', '[data-code-block]', '[data-chat-steering-batch]',
      '[data-submission-echo]', '[data-pending-steering]', 'nav',
    ].join(', ')

    /** Copy supplied to the Client locale service. */
    const zh = {
      collapse: '折叠这个话题',
      expand: '展开这个话题',
      generating: '正在生成，结束后可折叠',
      collapseAll: '全部折叠',
      expandAll: '全部展开',
    }
    const en = {
      collapse: 'Collapse this topic',
      expand: 'Expand this topic',
      generating: 'Generating — collapse after it finishes',
      collapseAll: 'Collapse all',
      expandAll: 'Expand all',
    }

    /** Sessions kept in storage; older ones are dropped on write. */
    const MAX_SESSIONS = 200
    /** Turns kept per Session; deeper histories are trimmed. */
    const MAX_TURNS = 2000

    /** Collapsed turn numbers per Session id. */
    const collapsed = new Map()
    /** Render listeners; every mounted control subscribes. */
    const listeners = new Set()
    let saveTimer = null

    /**
     * Publish one state change to every mounted control.
     * @returns {void}
     */
    function emit() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[topic-fold] listener failed', error)
        }
      }
    }

    /**
     * Subscribe one control to state changes.
     * @param {() => void} listener - render trigger.
     * @returns {() => void} unsubscribe.
     */
    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    /** Read the persisted map once, discarding anything malformed. */
    function restore() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null) return
        const data = JSON.parse(raw)
        if (data === null || typeof data !== 'object') return
        for (const [sessionId, turns] of Object.entries(data)) {
          if (typeof sessionId !== 'string' || !Array.isArray(turns)) continue
          const set = new Set()
          for (const turn of turns) {
            if (Number.isSafeInteger(turn) && turn >= 0) set.add(turn)
          }
          if (set.size > 0) collapsed.set(sessionId, set)
        }
      } catch (error) {
        console.warn('[topic-fold] could not read saved state', error)
      }
    }

    /** Write the map back, bounded so the key cannot grow without limit. */
    function persist() {
      try {
        const ids = [...collapsed.keys()]
        const kept = ids.slice(Math.max(0, ids.length - MAX_SESSIONS))
        const data = {}
        for (const sessionId of kept) {
          const set = collapsed.get(sessionId)
          if (set === undefined || set.size === 0) continue
          data[sessionId] = [...set].sort((left, right) => left - right).slice(-MAX_TURNS)
        }
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      } catch (error) {
        console.warn('[topic-fold] could not save state', error)
      }
    }

    /** Coalesce writes so a bulk toggle stores once. */
    function persistSoon() {
      if (saveTimer !== null) return
      saveTimer = window.setTimeout(() => {
        saveTimer = null
        persist()
      }, 250)
    }

    /**
     * @param {string} sessionId - Session id.
     * @param {number} turn - Turn number.
     * @returns {boolean} whether the topic is collapsed.
     */
    function isCollapsed(sessionId, turn) {
      const set = collapsed.get(sessionId)
      return set !== undefined && set.has(turn)
    }

    /**
     * Collapsed turns of one Session, ascending.
     * @param {string} sessionId - Session id.
     * @returns {readonly number[]} stored turn numbers.
     */
    function collapsedTurns(sessionId) {
      const set = collapsed.get(sessionId)
      return set === undefined ? [] : [...set].sort((left, right) => left - right)
    }

    /**
     * Set one topic's state and publish it.
     * @param {string} sessionId - Session id.
     * @param {number} turn - Turn number.
     * @param {boolean} next - collapsed when true.
     * @returns {void}
     */
    function setCollapsed(sessionId, turn, next) {
      let set = collapsed.get(sessionId)
      if (next) {
        if (set === undefined) {
          set = new Set()
          collapsed.set(sessionId, set)
        }
        if (set.has(turn)) return
        set.add(turn)
      } else {
        if (set === undefined || !set.has(turn)) return
        set.delete(turn)
        if (set.size === 0) collapsed.delete(sessionId)
      }
      persistSoon()
      emit()
    }

    /**
     * Set several topics at once, publishing one change.
     * @param {string} sessionId - Session id.
     * @param {readonly number[]} turns - Turns to change.
     * @param {boolean} next - collapsed when true.
     * @returns {void}
     */
    function setMany(sessionId, turns, next) {
      let changed = false
      for (const turn of turns) {
        let current = collapsed.get(sessionId)
        const alreadyCollapsed = current !== undefined && current.has(turn)
        if (alreadyCollapsed === next) continue
        if (next) {
          if (current === undefined) {
            current = new Set()
            collapsed.set(sessionId, current)
          }
          current.add(turn)
        } else if (current !== undefined) {
          current.delete(turn)
          if (current.size === 0) collapsed.delete(sessionId)
        }
        changed = true
      }
      if (!changed) return
      persistSoon()
      emit()
    }

    /** Re-render on any collapse-state change. */
    function useFoldState() {
      const [, force] = React.useReducer(count => count + 1, 0)
      React.useEffect(() => subscribe(force), [])
    }

    /**
     * Resolve a displayed string, tolerating a missing locale binding.
     * @param {((key: string) => string) | undefined} t - slot translator.
     * @param {'collapse'|'expand'|'generating'|'collapseAll'|'expandAll'} key - message key.
     * @returns {string} copy.
     */
    function label(t, key) {
      return typeof t === 'function' ? t(key) : en[key]
    }

    /** Static presentation; component-local, so unmounting removes it. */
    const CHROME = `
.dsh-topic-fold-seat{position:relative;display:block;width:100%;height:0;margin:0;pointer-events:none}
.dsh-topic-fold-toggle{pointer-events:auto;position:absolute;left:0;top:6px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0.5px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;transition:background 120ms ease,color 120ms ease,border-color 120ms ease}
@media (hover:hover){.dsh-topic-fold-toggle:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}}
.dsh-topic-fold-toggle[data-collapsed]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dsh-topic-fold-toggle[aria-disabled="true"]{cursor:default;opacity:.4}
.dsh-topic-fold-toggle:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:0}
.dsh-topic-fold-chevron{display:block;flex:none;transition:transform 120ms ease}
.dsh-topic-fold-chevron[data-collapsed]{transform:rotate(-90deg)}
.dsh-topic-fold-header{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
@media (hover:hover){.dsh-topic-fold-header:hover{background:var(--dsw-alias-bg-layer-2)}}
.dsh-topic-fold-header:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
@media (prefers-reduced-motion:reduce){.dsh-topic-fold-chevron,.dsh-topic-fold-toggle{transition:none}}
`

    /** Node kinds that must stay readable even inside a collapsed topic. */
    const ALWAYS_VISIBLE_KINDS = [
      'user', 'steering', 'turn-trigger', 'command',
      'turn-error', 'turn-max-tokens', 'model-retry', 'unknown',
    ]

    /**
     * Remove characters that could break out of a CSS string.
     * @param {string} value - Session id.
     * @returns {string} printable scope.
     */
    function cssText(value) {
      return String(value).replace(/["\\\n\r]/g, '')
    }

    /**
     * One scoped rule hiding a collapsed topic's body while keeping its prompts
     * and its failures.
     * @param {string} sessionId - Session id.
     * @param {number} turn - Turn number.
     * @returns {string} one CSS rule.
     */
    function hideRule(sessionId, turn) {
      const guard = ALWAYS_VISIBLE_KINDS
        .map(kind => `:not([data-chat-flow-kind="${kind}"])`)
        .join('')
      return `[data-conversation-session="${cssText(sessionId)}"] [data-chat-turn="${turn}"]${guard}`
        + '{display:none!important}'
    }

    /**
     * Rules for every stored turn of one Session.
     * @param {string} sessionId - Session id.
     * @returns {string} zero or more CSS rules.
     */
    function hideRules(sessionId) {
      return collapsedTurns(sessionId).map(turn => hideRule(sessionId, turn)).join('\n')
    }

    /** One 12px chevron, pointing right while collapsed. */
    function Chevron({ isCollapsed }) {
      return h('svg', {
        className: 'dsh-topic-fold-chevron',
        'data-collapsed': isCollapsed ? '' : undefined,
        viewBox: '0 0 12 12',
        width: 12,
        height: 12,
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', {
        d: 'M2.5 4.5 6 8l3.5-3.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /** Locate the Chat scrollport of one Session, if it is on screen. */
    function scrollerOf(sessionId) {
      const scope = document.querySelector(`[data-conversation-session="${cssText(sessionId)}"]`)
      return scope === null ? null : scope.querySelector('[data-conversation-scroll]')
    }

    /** The topmost prompt Turn currently inside the viewport. */
    function firstVisibleTurn(sessionId) {
      const scroller = scrollerOf(sessionId)
      if (scroller === null) return null
      const top = scroller.getBoundingClientRect().top
      const rows = scroller.querySelectorAll('[data-chat-flow-kind="user"][data-chat-turn]')
      for (const row of rows) {
        const rect = row.getBoundingClientRect()
        if (rect.bottom > top + 4) {
          const turn = Number(row.getAttribute('data-chat-turn'))
          return Number.isSafeInteger(turn) ? turn : null
        }
      }
      return null
    }

    /**
     * Bring one Turn's prompt back into the viewport after a bulk change.
     * @param {string} sessionId - Session id.
     * @param {number} turn - Turn to keep in view.
     * @returns {void}
     */
    function revealTurn(sessionId, turn) {
      const apply = () => {
        const scope = document.querySelector(`[data-conversation-session="${cssText(sessionId)}"]`)
        if (scope === null) return
        // A reader pinned to the newest output keeps that position; the fold
        // itself already removed the rows they were reading above it.
        if (scope.querySelector('[data-chat-following-tail]') !== null) return
        const scroller = scope.querySelector('[data-conversation-scroll]')
        if (scroller === null) return
        // A reader sitting at the floor is following the newest output; moving
        // scrollTop would opt out of that follow. Leave the floor alone.
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 24) return
        const row = scroller.querySelector(`[data-chat-flow-kind="user"][data-chat-turn="${turn}"]`)
        if (row === null) return
        const top = scroller.getBoundingClientRect().top
        const rect = row.getBoundingClientRect()
        // Scrolling is avoided when the prompt is already in view.
        if (rect.top >= top && rect.bottom <= top + scroller.clientHeight) return
        scroller.scrollTop += rect.top - top - 8
      }
      window.requestAnimationFrame(() => { window.requestAnimationFrame(apply) })
    }

    /** Nearest Conversation host for one Session, if it is on screen. */
    function scopeOf(sessionId) {
      return document.querySelector(`[data-conversation-session="${cssText(sessionId)}"]`)
    }

    /**
     * Turns that currently render a prompt row in one Conversation.
     * @param {Element|null} host - Conversation host.
     * @returns {number[]} ascending turn numbers.
     */
    function promptTurnsOf(host) {
      if (host === null) return []
      const turns = new Set()
      for (const row of host.querySelectorAll('[data-chat-flow-kind="user"][data-chat-turn]')) {
        const turn = Number(row.getAttribute('data-chat-turn'))
        if (Number.isSafeInteger(turn) && turn >= 0) turns.add(turn)
      }
      return [...turns].sort((left, right) => left - right)
    }

    /**
     * Whether one Conversation is streaming a Turn right now.
     * @param {Element|null} host - Conversation host.
     * @returns {boolean} streaming state.
     */
    function runningIn(host) {
      return host !== null && host.querySelector('[data-chat-running]:not([data-holding])') !== null
    }

    /**
     * Loaded prompt turns a bulk fold may take; the streaming Turn is excluded.
     * @param {string} sessionId - Session id.
     * @returns {number[]} ascending turn numbers.
     */
    function foldableTurns(sessionId) {
      const host = scopeOf(sessionId)
      const turns = promptTurnsOf(host)
      if (turns.length === 0 || !runningIn(host)) return turns
      return turns.filter(turn => turn !== turns[turns.length - 1])
    }

    /**
     * Collapse every loaded topic of one Conversation through one state change.
     * @param {string} sessionId - Session id.
     * @returns {void}
     */
    function foldAllInChat(sessionId) {
      const turns = foldableTurns(sessionId)
      if (turns.length === 0) return
      const anchor = firstVisibleTurn(sessionId)
      setMany(sessionId, turns, true)
      if (anchor !== null) revealTurn(sessionId, anchor)
    }

    /**
     * Expand every stored collapsed topic of one Conversation.
     * @param {string} sessionId - Session id.
     * @returns {void}
     */
    function unfoldAllInChat(sessionId) {
      const turns = collapsedTurns(sessionId)
      if (turns.length > 0) setMany(sessionId, turns, false)
    }

    /**
     * The per-topic control in the empty left margin of one prompt.
     *
     * The owning Turn number is read from Chat's own row wrapper (the seat's
     * closest ancestor). The control is absolutely positioned inside a
     * zero-height seat, so it adds no vertical space to the transcript.
     */
    function TopicSeat({ sessionId, t, useChat, useSession }) {
      useFoldState()
      const [turn, setTurn] = React.useState(null)
      const seatRef = React.useRef(null)
      const newestTurn = useChat((snapshot) => {
        const items = snapshot.navigation.items()
        return items.length === 0 ? -1 : items[items.length - 1].turn
      })
      const running = useSession(snapshot => snapshot.running)
      React.useLayoutEffect(() => {
        const element = seatRef.current
        if (element === null || typeof element.closest !== 'function') return
        const row = element.closest('[data-chat-turn]')
        const raw = row === null ? null : row.getAttribute('data-chat-turn')
        const parsed = raw === null ? null : Number(raw)
        const next = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
        setTurn(previous => (previous === next ? previous : next))
      })
      if (typeof sessionId !== 'string') return null
      if (turn === null) return h('span', { ref: seatRef, className: 'dsh-topic-fold-seat', 'data-topic-fold-seat': '' })
      const folded = isCollapsed(sessionId, turn)
      // The running Turn keeps its tokens visible, but a topic already folded
      // before it started stays expandable; otherwise the bulk action excluded
      // it and no other control could open it.
      const blocked = running && turn === newestTurn && !folded
      return h('span', { ref: seatRef, className: 'dsh-topic-fold-seat', 'data-topic-fold-seat': '' },
        h('style', null, CHROME + (folded ? hideRule(sessionId, turn) : '')),
        h('button', {
          type: 'button',
          className: 'dsh-topic-fold-toggle',
          'data-collapsed': folded ? '' : undefined,
          'aria-expanded': folded ? 'false' : 'true',
          'aria-disabled': blocked ? 'true' : undefined,
          'aria-label': label(t, blocked ? 'generating' : folded ? 'expand' : 'collapse'),
          title: label(t, blocked ? 'generating' : folded ? 'expand' : 'collapse'),
          onClick: () => {
            if (blocked) return
            setCollapsed(sessionId, turn, !folded)
          },
        }, h(Chevron, { isCollapsed: folded })))
    }

    /** Two chevrons: toward each other to collapse, outward to expand. */
    function FoldAllGlyph({ isCollapsed }) {
      const up = isCollapsed ? 'M3.5 6.5 7 3 10.5 6.5' : 'M3.5 7 7 10.5 10.5 7'
      const down = isCollapsed ? 'M3.5 10.5 7 7 10.5 10.5' : 'M3.5 3 7 6.5 10.5 3'
      return h('svg', {
        viewBox: '0 0 14 14',
        width: 14,
        height: 14,
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
      },
      h('path', { d: up, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('path', { d: down, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    /** Menu glyph for folding every topic. */
    function FoldMenuIcon() {
      return h(FoldAllGlyph, { isCollapsed: false })
    }

    /** Menu glyph for expanding every topic. */
    function UnfoldMenuIcon() {
      return h(FoldAllGlyph, { isCollapsed: true })
    }

    /**
     * Session-header action: collapse or expand every loaded topic at once,
     * and the one place that always owns this Session's hiding rules.
     */
    function FoldAllAction(props) {
      // The header entry exists in every Session; without Chat's standard hooks
      // there is no topic list to act on, so only the rules are rendered.
      if (typeof props.useChat !== 'function' || typeof props.useSession !== 'function') {
        return props.sessionId === undefined ? null : h('style', null, hideRules(props.sessionId))
      }
      return h(FoldAllBody, props)
    }

    /** Bulk control body; runs only where Chat's standard hooks are bound. */
    function FoldAllBody({ sessionId, useChat, useSession, t }) {
      useFoldState()
      // Turn-number signature, not the preview array: streaming replaces the
      // array's identity on every token, this string only on structure changes.
      const signature = useChat((snapshot) => {
        const turns = []
        for (const item of snapshot.navigation.items()) {
          if (item.prompt !== '') turns.push(item.turn)
        }
        return turns.join(',')
      })
      const newestTurn = useChat((snapshot) => {
        const items = snapshot.navigation.items()
        return items.length === 0 ? -1 : items[items.length - 1].turn
      })
      const running = useSession(snapshot => snapshot.running)
      if (typeof sessionId !== 'string') return null
      const promptTurns = signature === '' ? [] : signature.split(',').map(Number)
      // The running Turn stays out: collapsing it would hide live output.
      const targets = running ? promptTurns.filter(turn => turn !== newestTurn) : promptTurns
      const allCollapsed = targets.length > 0 && targets.every(turn => isCollapsed(sessionId, turn))
      const key = allCollapsed ? 'expandAll' : 'collapseAll'
      const onClick = () => {
        if (targets.length === 0) return
        if (allCollapsed) unfoldAllInChat(sessionId)
        else foldAllInChat(sessionId)
      }
      return h(React.Fragment, null,
        h('style', null, hideRules(sessionId)),
        targets.length === 0
          ? null
          : h('button', {
            type: 'button',
            className: 'dsh-topic-fold-header',
            'aria-label': label(t, key),
            title: label(t, key),
            onClick,
          },
          h(FoldAllGlyph, { isCollapsed: allCollapsed }),
          h('span', null, label(t, key))))
    }

    /** One stable chain match: the selector may run on every row render. */
    const USER_MATCH = Object.freeze({ fold: true })

    restore()

    return {
      inject: ['slots', 'locale', 'contextMenus'],

      /**
       * Register copy, the per-topic seat, and the bulk header action.
       * @param {object} ctx - browser plugin context.
       * @returns {void}
       */
      apply(ctx) {
        console.log('[topic-fold] client', VERSION, 'loaded')
        ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'topic-fold: copy')
        ctx.effect(() => () => {
          if (saveTimer !== null) {
            window.clearTimeout(saveTimer)
            saveTimer = null
            persist()
          }
        }, 'topic-fold: flush saved state')
        ctx.slots.inject('conversation.chat.user.before', () => ctx.slots.register({
          name: 'conversation.chat.user.before',
          select: owner => (owner.kind === 'user' ? USER_MATCH : null),
          locale: NAMESPACE,
        }, TopicSeat))
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'topic-fold-all',
          order: -20,
          locale: NAMESPACE,
        }, FoldAllAction))

        // The background menu relies on the shared context-menu service, so the
        // plugin declares it in `inject` and only activates where menus exist.
        const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NAMESPACE) : undefined
        const actionsFor = (value) => {
          const sessionId = value !== null && typeof value === 'object'
            && typeof value.sessionId === 'string' ? value.sessionId : ''
          if (sessionId === '') return []
          if (promptTurnsOf(scopeOf(sessionId)).length === 0) return []
          const anyOpen = foldableTurns(sessionId).some(turn => !isCollapsed(sessionId, turn))
          const folded = collapsedTurns(sessionId).length > 0
          return [
            {
              id: 'fold-all',
              label: label(t, 'collapseAll'),
              icon: { key: 'topic-fold.collapse' },
              disabled: !anyOpen,
              run: () => { foldAllInChat(sessionId) },
            },
            {
              id: 'unfold-all',
              label: label(t, 'expandAll'),
              icon: { key: 'topic-fold.expand' },
              disabled: !folded,
              run: () => { unfoldAllInChat(sessionId) },
            },
          ]
        }
        // A right-click counts as empty transcript when no link, control,
        // message text, composer surface, or menu occupies it. Row wrappers,
        // the gaps between rows, the gutters beside the column and the band
        // below the last message are containers, so they qualify.
        const openOnBlank = (event) => {
          const target = event.target instanceof Element ? event.target : null
          if (target === null) return
          const owner = target.closest(BLANK_EXCLUSIONS)
          if (owner !== null) {
            // Verbose-level breadcrumb: names the element that kept its own
            // gesture, so a rejected spot is diagnosable from the console.
            console.debug('[topic-fold] right-click belongs to', owner.tagName.toLowerCase(),
              owner.className === '' ? '(no class)' : String(owner.className).slice(0, 60))
            return
          }
          const host = target.closest('[data-conversation-session]')
          if (host === null) return
          const sessionId = host.getAttribute('data-conversation-session')
          if (sessionId === null || sessionId === '') return
          const selection = window.getSelection()
          if (selection !== null && !selection.isCollapsed && selection.toString().trim() !== '') return
          const turns = promptTurnsOf(host)
          if (turns.length === 0) return
          // Claim the gesture now, decide after every other handler ran: a
          // component that opens its own menu (file, link, image, tab) keeps
          // it, and only an untouched gesture becomes this menu.
          const before = ctx.contextMenus.active.getSnapshot()
          const point = { x: event.clientX, y: event.clientY }
          event.preventDefault()
          window.setTimeout(() => {
            if (ctx.contextMenus.active.getSnapshot() !== before) return
            console.log('[topic-fold] blank-area menu', sessionId, turns.length)
            ctx.contextMenus.open({ kind: MENU_TARGET_KIND, value: { sessionId } }, point)
          }, 0)
        }
        ctx.effect(() => {
          // Window capture is the earliest point of the event path: the
          // gesture reaches this listener before any component that also
          // handles contextmenu, and the exclusions alone decide whether the
          // click belongs to a message.
          window.addEventListener('contextmenu', openOnBlank, true)
          return () => { window.removeEventListener('contextmenu', openOnBlank, true) }
        }, 'topic-fold: blank-area menu')
        ctx.effect(() => ctx.contextMenus.register({
          id: 'topic-fold.chat-blank',
          target: MENU_TARGET_KIND,
          order: 120,
          resolve: actionsFor,
        }), 'topic-fold: menu actions')
        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon', key: 'topic-fold.collapse',
        }, FoldMenuIcon))
        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon', key: 'topic-fold.expand',
        }, UnfoldMenuIcon))
        console.log('[topic-fold] blank-area menu ready')
      },
    }
  },
})
