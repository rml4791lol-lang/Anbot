// The whale director: turns start snapshots into whale motion. The whale stays in the middle of
// a ring of arcs, one per stage (three; four on a first start that copies a team), and the ring is
// the progress: an arc turns active, then
// fills as its stage is done, and the ring closes at the hand-off. The director keeps the arcs
// (.arc data-state) and the hidden stage list (.station data-state, aria-current) for the live
// region and screen readers. A click on the whale makes it spout.
// Layers (start.html): .whale-x the box > .whale-breath breath scale > .whale scale >
// .whale-move one-shots > .whale-loop CSS state loops > .whale-img bitmap.
// One-shots run on WAAPI and end with commitStyles() + cancel(); loops are CSS keyed on
// html[data-whale]. Every await is raced against a timer, because a
// hidden document stops ticking animations.

const root = document.documentElement
const rm = matchMedia('(prefers-reduced-motion: reduce)')
const tierNow = () => root.dataset.motion || 'normal'
const effectsNow = () => root.dataset.effects || 'full'
// html[data-tier] is the tier the CSS reads; it follows data-motion (the snapshot's tier).
const syncTier = () => { if (root.dataset.tier !== tierNow()) root.dataset.tier = tierNow() }
syncTier()
new MutationObserver(syncTier).observe(root, { attributes: true, attributeFilter: ['data-motion'] })
export const reduced = () => rm.matches || effectsNow() === 'off'
export const reducedFx = () => rm.matches || effectsNow() !== 'full'
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const cs = el => getComputedStyle(el)
const IDENTITY = /^(none|1|0px|0px 0px|matrix\(1, 0, 0, 1, 0, 0\))$/u
const CLEAR = ['transform', 'scale', 'translate']
const OUT = 'cubic-bezier(.4,0,.2,1)'
const HOP = 'cubic-bezier(.3,.7,.4,1)'
const PHASES = ['data', 'engine', 'team']
// The path of an arc round the whale from one angle to another, in degrees clockwise from the top.
export function arcD(from, to) {
  const at = (deg) => {
    const r = (deg * Math.PI) / 180
    return `${(110 + 106 * Math.sin(r)).toFixed(2)} ${(110 - 106 * Math.cos(r)).toFixed(2)}`
  }
  return `M${at(from)}A106 106 0 ${to - from > 180 ? 1 : 0} 1 ${at(to)}`
}
// Arc k of n: 10 degrees between arcs.
export const arcPath = (k, n) => arcD(k * (360 / n) + 5, (k + 1) * (360 / n) - 5)
// Where each stage's arc runs on a ring of these stages. On a ring of three, the import's arc is a
// point in the gap after the data folder's, where it grows from.
function spansOf(list) {
  const out = { import: [120, 120] }
  list.forEach((phase, k) => { out[phase] = [k * (360 / list.length) + 5, (k + 1) * (360 / list.length) - 5] })
  return out
}
// An active station and a state loop each hold at least 400 ms; the margin covers the frame
// on which the change is painted.
const HOLD = 420
// The whale is 112 px on every kind of start (start.css --u). Starting over in a new folder, it
// sinks this far: under the waterline.
const u = 1.12
const SINK = 84
// Hops land at .55 of their 1.3 s cycle; the lively tier spaces further hops out, never closer.
const HOP_MS = 1300
const LANDED = 0.55 * HOP_MS
const MORE_HOPS = [2600, 5200]
const HOP_EVERY = 9000
// Acts that only open, fold or copy something on the card; every other card button answers it.
const LOCAL = new Set(['toggleDetails', 'toggleMore', 'toggleModels', 'copyDetails'])
// Waits get calmer on the card's own clock: rates after 30 s and after 90 s.
const calmer = ms => (ms >= 90000 ? [0.6, 2] : ms >= 30000 ? [0.8, 1.4] : [1, 1])

const springs = {}
export function spring(name) {
  if (!springs[name]) {
    const style = cs(root)
    springs[name] = { duration: parseFloat(style.getPropertyValue(`--spring-${name}-ms`)) || 420, easing: style.getPropertyValue(`--spring-${name}`).trim() || 'ease-out' }
  }
  return springs[name]
}

let instant = false
// Plays keyframes; with `instant` (a resumed page) it writes the last frame and returns at once.
export function play(el, frames, opts) {
  if (instant) {
    for (const [key, value] of Object.entries(frames.at(-1))) if (key !== 'offset' && key !== 'easing') el.style[key] = CLEAR.includes(key) && IDENTITY.test(String(value)) ? '' : value
    return { done: Promise.resolve(), cancel() {}, finish() {}, commitStyles() {} }
  }
  const anim = el.animate(frames, { fill: 'forwards', ...opts })
  const count = opts.iterations ?? 1
  anim.done = count === Infinity ? new Promise(() => {}) : Promise.race([anim.finished.catch(() => {}), sleep((opts.delay ?? 0) + (opts.duration ?? 0) * count + 150)])
  return anim
}
// Ends a one-shot at its end state: finish, commit through CSSOM (CSP allows it), cancel.
export function settle(anim, el, commit = true) {
  if (!anim?.effect || anim.playState === 'idle') return
  try { if (anim.playState !== 'finished' && anim.effect.getComputedTiming().iterations !== Infinity) anim.finish() } catch { /* infinite */ }
  if (commit) try { anim.commitStyles() } catch { /* not rendered */ }
  anim.cancel()
  for (const key of CLEAR) if (IDENTITY.test(el.style[key])) el.style.removeProperty(key)
}
const scripted = el => el.getAnimations().filter(a => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition))
// Replaces earlier one-shots on el, keeping the pose they have reached this frame (never
// their end state: finishing one mid-flight would teleport the whale).
function drop(el) {
  for (const a of scripted(el)) {
    try { a.commitStyles() } catch { /* not rendered */ }
    a.cancel()
  }
  for (const key of CLEAR) if (IDENTITY.test(el.style[key])) el.style.removeProperty(key)
}
function to(el, props, opts) {
  const from = {}
  for (const key of Object.keys(props)) from[key] = cs(el)[key]
  drop(el)
  const anim = play(el, [from, props], opts)
  anim.done.then(() => settle(anim, el))
  return anim
}
const kf = (frames, easing) => frames.map(frame => ({ easing, ...frame }))
export const clamped = easing => easing.replace(/\d+\.\d+/gu, value => String(Math.min(1, Number(value))))

export function createDirector({ start, resume, act, label, announce, onCheck, onActive, begin = Promise.resolve() }) {
  const $ = selector => document.querySelector(selector)
  const x = $('.whale-x'), breathLayer = $('.whale-breath'), body = $('.whale'), move = $('.whale-move'), loop = $('.whale-loop')
  const lane = $('.lane'), ripple = $('.ripple'), hit = $('.whale-hit')
  const stations = [...document.querySelectorAll('.station')]
  const ring = $('.ring'), importArc = $('.arc[data-phase=import]')
  // The stages of this start, in order (the snapshot's phases).
  let phases = PHASES
  const last = () => phases.length - 1
  const stationEl = i => stations.find(st => st.dataset.phase === phases[i])
  const arcEl = i => document.querySelector(`.arc[data-phase="${phases[i]}"]`)
  // The import's arc runs while the copy does.
  const copying = () => want.card === 'copying'
  // A start that offers an import holds after the data folder's arc until the import card is
  // answered: the engine warms up meanwhile, but its arc does not run ahead of the question.
  const holding = () => D.offer && !D.answered
  const first = start === 'first'
  // The entrance's clock starts once the window is on screen (`begin`, start.js).
  let t0 = performance.now()
  const entranceMs = resume ? 0 : first ? 1300 : 290
  const D = { at: 0, checks: 0, passed: 0, pose: 'enter', loop: '', card: '', slow: 0, since: [t0], activeAt: [], loopAt: 0, hop: null, pet: null, handed: false, workReady: first, missed: false, sinking: false,
    // Rest on a card: its clock, the lean, the breath, the lively hops; the press.
    clockKind: '', cardAt: 0, lean: false, leanDue: false, leanOff: false, leanMine: -1, restMine: -1, breath: null, hopsStopped: false, legging: false, press: null, nodAt: 0 }
  const rnd = Math.random
  let want = { station: 0, view: 'boot', phase: 'data', done: [], card: '', missed: false, celebrate: first, update: '' }
  let token = 0
  let wake = () => {}
  let bumped = new Promise(resolve => { wake = resolve })
  // Timers of the rest on a card belong to one token; a new state drops them all.
  const timers = new Set()
  function later(mine, ms, fn) {
    const id = setTimeout(() => { timers.delete(id); if (mine === token) fn() }, Math.max(0, ms))
    timers.add(id)
  }
  const bump = () => {
    token += 1
    for (const id of timers) clearTimeout(id)
    timers.clear()
    stopBreath()
    unpress()
    wake()
    bumped = new Promise(resolve => { wake = resolve })
  }
  const until = promise => Promise.race([promise, bumped])
  const wait = ms => (instant ? Promise.resolve() : sleep(ms))
  const tier = tierNow
  const playful = () => tier() !== 'quiet' && !reduced()
  const failure = () => want.view === 'failed' || want.view === 'viewFailed' || want.card === 'importFailed'
  const begun = begin.then(() => { t0 = performance.now(); D.since[0] = t0 })
  const entered = begun.then(() => sleep(entranceMs)).then(() => { root.dataset.entered = '' })
  // Finished entrance veils are dropped, so later fades of the same blocks stay composited.
  begun.then(() => sleep(resume ? 0 : first ? 1650 : 700)).then(() => { root.dataset.settled = '' })
  if (resume) instant = true
  if (!first) begun.then(() => { setTimeout(() => { D.workReady = true; if (D.started) kick() }, resume ? 0 : 1000) })

  // ---- stages: the ring's arcs and the hidden list ----
  // Each arc carries its stage's state: pending (faint), active (tinted, a light running along
  // it), done (drawn in the whale's blue) or failed (red); start.css draws them.
  function setStation(i, state) {
    const st = stationEl(i)
    if (!st || st.dataset.state === state) return
    st.dataset.state = state
    arcEl(i).dataset.state = state
    st.querySelector('.sr').textContent = label(`status.state.${state}`)
    if (state === 'active') st.setAttribute('aria-current', 'step')
    else st.removeAttribute('aria-current')
  }
  function popCheck(i) {
    if (D.checks > i) return
    D.checks = i + 1
    setStation(i, 'done')
    announce(label('status.sr.done', { phase: label(`status.phase.${phases[i]}`) }))
    onCheck?.(i)
    // Its fill is drawn (.56 s, .12 s with reduced motion) before anything waits on it.
    setTimeout(() => {
      D.passed = Math.max(D.passed, i + 1)
      const due = throughs.filter(([at]) => at < D.passed)
      throughs = throughs.filter(([at]) => at >= D.passed)
      for (const [, resolve] of due) resolve()
    }, instant ? 0 : reduced() ? 120 : 560)
  }
  let throughs = []
  let activeTimer = 0
  function armActive() {
    clearTimeout(activeTimer)
    const i = D.at
    if (D.handed || failure() || i > last() || D.checks > i || stationEl(i).dataset.state !== 'pending' || (holding() && i >= 1)) return
    if (i < last() && want.done.includes(phases[i])) return
    // The import's arc turns active once the copy runs and the card has flown into it.
    if (phases[i] === 'import' && (!copying() || D.flying)) return
    const now = performance.now()
    const delay = Math.max(0, (D.since[i] ?? now) + 250 - now, t0 + entranceMs - now)
    activeTimer = setTimeout(() => {
      if (D.at !== i || stationEl(i).dataset.state !== 'pending' || failure() || (i < last() && want.done.includes(phases[i]))) return
      showActive(i)
    }, instant ? 0 : delay)
  }
  function showActive(i) {
    setStation(i, 'active')
    D.activeAt[i] = performance.now()
    announce(label('status.sr.active', { phase: label(`status.phase.${phases[i]}`) }))
    onActive?.(i)
  }

  // ---- loops ----
  const capture = () => ({ loop: cs(loop).transform })
  // Every pose change starts here and then slides .whale-loop from where it is, lean included.
  const stopLoop = () => { delete root.dataset.whale; D.loop = ''; D.lean = false }
  function slide(el, from, target, opts) {
    drop(el)
    if (from === 'none' && target === 'none') return null
    const anim = play(el, [{ transform: from }, { transform: target }], opts)
    anim.done.then(() => settle(anim, el))
    return anim
  }
  function release(pose, opts) {
    slide(loop, pose.loop, 'none', opts)
  }
  const START = { searching: { loop: 'rotate(-4deg)' }, pondering: { loop: 'rotate(4deg)' } }
  async function startLoop(name) {
    if (D.loop === name) return
    const mine = token
    const pose = capture()
    stopLoop()
    if (!reduced()) {
      const shape = spring('shape')
      const begin = START[name] ?? {}
      slide(loop, pose.loop, begin.loop ?? 'none', shape)
      await until(wait(shape.duration))
      if (mine !== token) return
    }
    // The slides end on the loop's first frame, so dropping them in the same task as the
    // switch shows no jump.
    for (const a of scripted(loop)) a.cancel()
    loop.style.removeProperty('transform')
    root.dataset.whale = name
    D.loop = name
    D.loopAt = performance.now()
    if (D.slow === 1) calm()
  }
  // Calmer, never faster (S6): every running whale animation at .85, no phase jump.
  function calm() {
    for (const el of [loop, move]) for (const a of el.getAnimations()) if (a.playbackRate === 1) a.updatePlaybackRate(0.85)
  }

  // ---- one-shots ----
  function nod() {
    if (!playful() || instant || ['down', 'lift', 'dive'].includes(D.pose) || D.pet || D.hop) return
    // One answer nods once, whichever listener asks first.
    if (performance.now() - D.nodAt < 150) return
    D.nodAt = performance.now()
    const a = play(move, [{ transform: 'none' }, { transform: 'translateY(2px) rotate(3deg)' }], { ...spring('tap'), fill: 'forwards' })
    setTimeout(() => {
      if (D.pet || D.hop || D.handed) return
      const from = cs(move).transform
      a.cancel()
      const b = play(move, [{ transform: from }, { transform: 'none' }], spring('shape'))
      b.done.then(() => settle(b, move))
    }, 160)
  }
  function hop(count) {
    const lift = `translateY(${(-8.1 * u).toFixed(2)}px) scale(.96,1.05)`
    const frames = kf([{ offset: 0, transform: 'none' }, { offset: 0.2, transform: lift }, { offset: 0.4, transform: 'translateY(0) scale(1.06,.94)' }, { offset: 0.55, transform: 'none' }, { offset: 1, transform: 'none' }], HOP)
    drop(move)
    return play(move, frames, { duration: HOP_MS, iterations: count, fill: 'none' })
  }
  function stopHop() {
    const a = D.hop
    if (!a) return
    D.hop = null
    const from = cs(move).transform
    a.cancel()
    if (from !== 'none') slide(move, from, 'none', spring('shape'))
  }
  function petStart() {
    if (!playful() || !['alert', 'rest'].includes(D.pose) || D.pet || D.handed) return
    stopHop()
    D.hopsStopped = true
    leanOut()
    const lean = `translate(${(4.6 * u).toFixed(2)}px, ${(-0.58 * u).toFixed(2)}px) rotate(8deg)`
    const nuzzle = `translate(${(7.4 * u).toFixed(2)}px, ${(-1.74 * u).toFixed(2)}px) rotate(14deg) scale(1.03, .97)`
    const a = to(move, { transform: lean }, spring('pop'))
    const b = play(move, [{ transform: lean }, { transform: nuzzle, offset: 0.5 }, { transform: lean }], { duration: 780, delay: 320, iterations: Infinity, easing: 'ease-in-out', fill: 'none' })
    D.pet = [a, b]
  }
  function petEnd() {
    if (!D.pet) return
    const from = cs(move).transform
    for (const a of D.pet) a.cancel()
    D.pet = null
    slide(move, from, 'none', spring('pop'))
    leanIn()
  }
  // ---- the spout: a click on the whale ----
  // A column rises from the blowhole, opens into two curls and lifts off, and drops fall from the
  // curls back into the water, with a ripple where they land. Four clicks within 2.5 s make a
  // bigger one; a whale that is down only puffs.
  const plume = $('.plume')
  const spoutEl = $('.spout')
  let clicks = []
  function fallDrop(dx0, dy0, { dx, fall, delay, size = 5.5 }) {
    const el = document.createElement('span')
    el.className = 'drop'
    el.style.width = el.style.height = `${size.toFixed(1)}px`
    spoutEl.append(el)
    const a = el.animate([
      { translate: `${dx0}px ${dy0}px`, scale: '.8', opacity: 0.95 },
      { translate: `${(dx0 + dx).toFixed(1)}px ${(dy0 + fall).toFixed(1)}px`, scale: '1', opacity: 0.55 },
    ], { duration: 520 + rnd() * 120, delay, easing: 'cubic-bezier(.5,0,.9,.5)', fill: 'backwards' })
    a.finished.then(() => el.remove(), () => el.remove())
  }
  function spout({ big = false, small = false } = {}) {
    if (!plume || reduced() || instant) return
    const k = small ? 0.55 : big ? 1.35 : tier() === 'quiet' ? 0.85 : 1
    const shape = plume.cloneNode(true)
    // An SVG element has no hidden property: the attribute itself goes.
    shape.removeAttribute('hidden')
    shape.style.scale = String(k)
    spoutEl.append(shape)
    const [stem, ...curls] = shape.querySelectorAll('path')
    const rise = 'cubic-bezier(.2,.7,.4,1)'
    stem.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 170, easing: rise, fill: 'forwards' })
    stem.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -1 }], { duration: 260, delay: 380, easing: 'ease-in', fill: 'forwards' })
    if (small) {
      for (const curl of curls) curl.remove()
      fallDrop(0, -27 * k, { dx: 3, fall: 46, delay: 300, size: 5 })
    } else {
      for (const curl of curls) {
        curl.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 200, delay: 120, easing: rise, fill: 'forwards' })
        curl.animate([{ strokeDashoffset: 0, opacity: 1 }, { strokeDashoffset: -0.7, opacity: 0 }], { duration: 240, delay: 420, easing: 'ease-in', fill: 'forwards' })
      }
      const per = big ? 3 : 2
      for (const side of [-1, 1]) for (let i = 0; i < per; i += 1) fallDrop(side * 18 * k, -31 * k, { dx: side * (4 + i * 5 + rnd() * 3), fall: 70 + i * 10 + rnd() * 10, delay: 330 + i * 70, size: 5 + rnd() * 1.5 })
      fallDrop(0, -38 * k, { dx: (rnd() - 0.5) * 6, fall: 80, delay: 400, size: 6 })
      // At the hand-off the dive sends the ripple; this one would land as the window fades.
      if (!D.handed) setTimeout(sendRipple, 760)
    }
    setTimeout(() => shape.remove(), 900)
  }
  function squash(big) {
    drop(body)
    const a = play(body, kf([{ scale: '1' }, { scale: big ? '1.07 .93' : '1.04 .96', offset: 0.3 }, { scale: '.96 1.05', offset: 0.62 }, { scale: '1' }], OUT), { duration: 460, fill: 'none' })
    a.done.then(() => a.cancel())
  }
  // She is paper, not a whale: a click answers with a nod and a squash, never a spout.
  function spoutClick() {
    if (D.handed || want.view === 'handoff' || ['dive', 'sunk', 'enter'].includes(D.pose) || D.sinking) return
    const now = performance.now()
    clicks = clicks.filter(at => now - at < 2500)
    clicks.push(now)
    const big = clicks.length >= 4
    if (big) clicks = []
    if (!reduced()) squash(big)
    nod()
  }
  function sendRipple() {
    if (!playful()) return
    play(ripple, [{ scale: '.5' }, { scale: '1.6' }], { ...spring('shape'), fill: 'none' })
    play(ripple, [{ opacity: 0.9 }, { opacity: 0 }], { duration: 160, easing: 'linear', fill: 'none' })
  }

  // ---- rest on a card: lean, breath, lively hops (none in quiet, reduced or failure) ----
  const stirs = () => playful() && !failure()
  const px = v => (v * u / 0.88).toFixed(2)
  // Nose 2.5° down toward the sheet, 1.5 px forward, 1 px up (at 88 px), on .whale-loop, which
  // no loop uses while a card waits, so hops, nods and petting compose on top of it.
  const LEAN = () => `translate(${px(1.5)}px, ${px(-1)}px) rotate(2.5deg)`
  function leanAt(mine, ms) {
    D.leanDue = false
    D.leanOff = false
    D.leanMine = mine
    if (!stirs()) return
    if (instant) { D.leanDue = true; leanIn(); return }
    later(mine, ms, () => { D.leanDue = true; leanIn() })
  }
  function leanIn() {
    if (D.lean || !D.leanDue || D.leanOff || D.leanMine !== token || D.pet || D.handed || !stirs() || !['alert', 'rest'].includes(D.pose)) return
    D.lean = true
    to(loop, { transform: LEAN() }, spring('shape'))
  }
  function leanOut() {
    if (!D.lean) return
    D.lean = false
    to(loop, { transform: 'none' }, spring('shape'))
  }
  function breathe(mine) {
    if (D.breath || instant || !stirs() || D.pose !== 'rest' || reducedFx()) return
    // Compositor-only: the scale property on an HTML wrapper that nothing else scales.
    const a = breathLayer.animate(kf([{ scale: '1' }, { scale: '1.008 1.018', offset: 0.45 }, { scale: '1' }], 'ease-in-out'), { duration: 4200, iterations: Infinity })
    D.breath = a
    const age = performance.now() - D.cardAt
    a.updatePlaybackRate(calmer(age)[0])
    const slower = () => { const rate = calmer(performance.now() - D.cardAt)[0]; if (D.breath === a && rate < a.playbackRate) a.updatePlaybackRate(rate) }
    for (const at of [30000, 90000]) if (age < at) later(mine, at - age, slower)
  }
  function stopBreath() {
    const a = D.breath
    if (!a) return
    D.breath = null
    const from = cs(breathLayer).scale
    a.cancel()
    if (!reduced() && from !== 'none' && from !== '1') play(breathLayer, [{ scale: from }, { scale: '1' }], { duration: 240, easing: 'ease-out', fill: 'none' })
  }
  function resting(mine) {
    D.restMine = mine
    if (!stirs()) return
    later(mine, 600, () => breathe(mine))
  }
  // Lively: after the two hops (starts 0 and 1.3 s), more at +2.6 s, +5.2 s, then every 9 s.
  function moreHops(mine, began) {
    let at = began + HOP_MS
    let k = 0
    const next = () => {
      at += MORE_HOPS[k] ?? HOP_EVERY
      k += 1
      later(mine, at - performance.now(), () => {
        if (D.hopsStopped || D.pose !== 'rest' || !stirs()) return
        if (D.pet || D.hop) { next(); return }
        const a = hop(1)
        D.hop = a
        a.done.then(() => { if (D.hop === a) { D.hop = null; a.cancel() } })
        next()
      })
    }
    next()
  }

  // ---- poses ----
  // A stage done: its arc fills while the whale, which stays where it is, gives a small surge
  // and a small surge forward. Stages done together follow each other faster.
  async function leg(i, queued) {
    D.legging = true
    clearTimeout(activeTimer)
    petEnd()
    stopHop()
    if (playful() && !instant) {
      const surge = play(move, kf([{ transform: 'none' }, { transform: `translateX(${px(4)}px) rotate(-3deg)`, offset: 0.4 }, { transform: 'none' }], OUT), { duration: 420, fill: 'none' })
      surge.done.then(() => surge.cancel())
    }
    popCheck(i)
    D.at = i + 1
    await hold(performance.now() + (queued ? 200 : 360))
    D.legging = false
  }
  // Waits until `at`. Other states keep the wait, but the hand-off does not: it fills the arcs
  // left at once, and a beat in front of it would push handoffShow past the main process's
  // fallback (start-window.mjs fallbackMs).
  async function hold(at) {
    if (instant) return
    while (performance.now() < at && want.view !== 'handoff') await until(wait(at - performance.now()))
  }
  async function runLegs() {
    let ran = 0
    while (D.at < want.station && want.view !== 'handoff') {
      const i = D.at
      // A copy can be done before the card has landed in its arc: the arc fills after that.
      if (phases[i] === 'import' && D.flying) return
      // A stage done while nobody could see it (the data folder before the page painted, the
      // engine while the import card waited or the copy ran) still turns active and holds there,
      // its prop in view, before it fills. No loop starts for that short wait: a loop's own hold
      // would add another 400 ms. A stage that was seen running fills at once.
      if (!resume && !failure() && stationEl(i).dataset.state === 'pending') {
        clearTimeout(activeTimer)
        showActive(i)
      }
      await hold(Math.max(D.activeAt[i] ? D.activeAt[i] + HOLD : 0, !ran && D.loopAt ? D.loopAt + HOLD : 0))
      if (want.view === 'handoff') break
      await leg(i, ran > 0)
      ran += 1
    }
    // The hand-off follows at once and takes the whale down; a nod now would bring it back up.
    if (!ran || want.view === 'handoff') return
    D.loopAt = 0
    armActive()
    if (D.at <= last() && !(D.at < last() && want.done.includes(phases[D.at]))) nod()
  }
  // A failed start turns its stage's arc red; the whale's pose says the rest.
  function failStation() {
    const i = want.view === 'viewFailed' ? last() : Math.min(D.at, Math.max(0, phases.indexOf(want.phase)))
    clearTimeout(activeTimer)
    if (D.checks > i) return
    D.failed = i
    setStation(i, 'failed')
  }
  // A failed copy turns the import's arc red, keeping what it had filled.
  function failImport() {
    const i = phases.indexOf('import')
    if (i < 0 || D.checks > i) return
    clearTimeout(activeTimer)
    D.failed = i
    setStation(i, 'failed')
  }
  async function goDown() {
    if (['down', 'lift'].includes(D.pose)) return
    stopHop()
    petEnd()
    D.pose = 'down'
    D.card = ''
    D.clockKind = ''
    if (want.view === 'failed' || want.view === 'viewFailed') failStation()
    else if (want.card === 'importFailed') failImport()
    const pose = capture()
    stopLoop()
    if (reduced()) return
    const shape = spring('shape')
    release(pose, shape)
    to(body, { scale: '1' }, shape)
    await until(to(move, { transform: 'translateY(4px) rotate(4deg)' }, shape).done)
  }
  async function lift() {
    if (D.pose !== 'down') return
    D.pose = 'lift'
    if (reduced()) return
    const shape = spring('shape')
    await until(to(move, { transform: 'translateY(2px)' }, shape).done)
  }
  async function shakeOff() {
    D.pose = 'loop'
    if (D.failed !== undefined) {
      const i = D.failed
      D.failed = undefined
      setStation(i, 'pending')
      armActive()
    }
    if (reduced()) { move.style.removeProperty('transform'); return }
    const shape = spring('shape')
    to(move, { transform: 'none' }, shape)
    drop(body)
    const s = play(body, kf([{ scale: '1' }, { scale: '.94 1.08', offset: 0.4 }, { scale: '1.03 .97', offset: 0.75 }, { scale: '1' }], OUT), { duration: 800 })
    await s.done
    settle(s, body)
  }
  async function resetRun() {
    // A new folder or a blank team: sink, empty the ring while under, resurface. No spout while
    // the whale is under (D.sinking).
    delete root.dataset.hurt
    delete root.dataset.hit
    $('.basin').style.opacity = '0'
    delete root.dataset.basin
    D.sinking = true
    petEnd()
    stopHop()
    const pose = capture()
    stopLoop()
    if (!reduced()) {
      release(pose, spring('shape'))
      to(move, { transform: `translateY(${SINK}px)` }, spring('shape'))
      play(move, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 })
      await wait(spring('shape').duration)
    } else await play(lane, [{ opacity: Number(cs(lane).opacity) }, { opacity: 0 }], { duration: 160 }).done
    for (let i = 0; i < phases.length; i += 1) setStation(i, 'pending')
    importArc?.style.removeProperty('--f')
    D.at = 0
    D.checks = 0
    D.passed = 0
    D.asked = false
    D.answered = false
    D.failed = undefined
    D.since = [performance.now()]
    D.activeAt = []
    for (const el of [move, body, lane]) { for (const a of scripted(el)) a.cancel(); el.style.removeProperty('transform'); el.style.removeProperty('opacity'); el.style.removeProperty('scale') }
    D.sinking = false
    D.pose = 'loop'
    if (!reduced()) {
      const up = play(move, [{ transform: `translateY(${SINK}px) rotate(-12deg)` }, { transform: 'none' }], { ...spring('stretch'), fill: 'none' })
      await up.done
    }
    armActive()
  }
  // Another state on the same card (a stage done, a retry that missed): the rest starts over.
  function restAgain(mine) {
    if (D.pose === 'alert' && !D.hop) D.pose = 'rest'
    if (D.pose !== 'rest' || D.restMine === mine) return
    leanAt(mine, 0)
    resting(mine)
  }
  async function cardPose() {
    const kind = want.view === 'watchdog' ? 'watchdog' : want.card
    const mine = token
    if (kind === D.card && !(want.missed && !D.missed)) { restAgain(mine); return }
    const previous = D.card
    D.card = kind
    if (kind !== D.clockKind) { D.clockKind = kind; D.cardAt = performance.now(); D.hopsStopped = false }
    if (kind === 'missing' && want.missed && !D.missed) {
      D.missed = true
      if (previous === 'missing') { restAgain(mine); return }
    }
    if (kind !== 'missing') D.missed = false
    if (kind === 'copying' || kind === 'newerUpdating') { stopHop(); D.pose = 'loop'; await startLoop('working'); return }
    if (kind === 'importFailed') return goDown()
    stopHop()
    const pose = capture()
    stopLoop()
    if (!reduced()) release(pose, spring('shape'))
    // Cards the user caused (picked, rejected, the stop confirmation) do not hop; they lean in
    // as the morph starts (the content veils in 70 ms later).
    const count = { recommend: 2, missing: 2, import: 2, newer: 2, watchdog: 2, importSpace: 1 }[kind] ?? 0
    if (!count || reduced()) { D.pose = 'rest'; leanAt(mine, 70); resting(mine); return }
    D.pose = 'alert'
    const began = performance.now()
    const a = hop(count)
    D.hop = a
    leanAt(mine, (count - 1) * HOP_MS + LANDED)
    await until(a.done)
    if (D.hop === a) stopHop()
    if (mine !== token) return
    D.pose = 'rest'
    resting(mine)
    if (tier() === 'lively' && count === 2) moreHops(mine, began)
  }
  async function phaseLoop() {
    stopHop()
    petEnd()
    D.card = ''
    D.clockKind = ''
    D.missed = false
    D.pose = 'loop'
    const name = D.slow >= 2 ? 'pondering' : !first ? (D.workReady ? 'working' : '') : ({ data: 'searching', engine: 'working', team: 'sending' }[want.phase] ?? '')
    if (name) await startLoop(name)
    else if (D.loop || D.lean) { const pose = capture(); stopLoop(); release(pose, { duration: 240, easing: 'ease-out' }) }
  }
  // The hand-off, the same for every kind of start: the arcs not yet done fill at once, the ring
  // closes into one circle (html[data-ring=closed]), and the whale goes. Every path shows the
  // team window well inside the main process's fallback (start-window.mjs fallbackMs).
  async function handoff() {
    if (D.handed || D.handing) return
    clearTimeout(activeTimer)
    // The team's arc gets its turn too when the team view was ready before the arc turned active
    // (it loaded while a card waited, or in a moment): on a first start, whose fallback leaves
    // the time (start-window.mjs fallbackMs, 2.5 s).
    const t = last()
    if (!resume && first && D.checks === t && stationEl(t).dataset.state === 'pending') {
      D.handing = true
      showActive(t)
      await sleep(HOLD)
      D.handing = false
    }
    stopHop()
    petEnd()
    for (let i = D.checks; i < phases.length; i += 1) popCheck(i)
    D.at = last()
    root.dataset.ring = 'closed'
    D.handed = true
    D.pose = 'dive'
    delete root.dataset.hurt
    const begin = performance.now()
    const at = ms => sleep(Math.max(0, begin + ms - performance.now()))
    const pose = capture()
    stopLoop()
    if (reduced()) return stillHandoff(at)
    release(pose, { duration: 200, easing: 'ease-out' })
    if (want.celebrate) return spoutHandoff(at)
    // A beat, then she ducks back under the paper edge: handoffShow at 220 ms. No leap to the
    // avatar, so the page never hands over the old hatted look.
    await at(100)
    root.dataset.exit = 'caption all'
    delete root.dataset.basin
    dive(12, DEEP(), 18, spring('tap'))
    await at(220)
    root.dataset.drop = ''
    if (playful()) {
      to(move, { transform: 'translate(0px, 680px) rotate(7deg)' }, { duration: 820, easing: 'cubic-bezier(.4,0,.9,1)' })
    } else move.style.transform = 'translate(0px, 680px) rotate(7deg)'
    await at(1040)
    act('handoffShow')
    await at(1280)
    act('handoffDone')
  }
  // A celebrating hand-off (a first start, or the first success after a failure): the ring
  // closes, an iron basin drops on her head, and she ducks back under the paper edge with it.
  // handoffShow at 720 ms. The basin is inside .whale-x, so it travels with her; the lane stops
  // clipping while data-basin is set, and clips her away as she goes under.
  async function spoutHandoff(at) {
    const basin = $('.basin')
    root.dataset.basin = ''
    basin.style.opacity = '1'
    basin.style.transform = 'translate(5px, -210px) rotate(-9deg)'
    drop(body)
    if (playful()) {
      play(basin, [
        { transform: 'translate(5px, -210px) rotate(-9deg)' },
        { transform: 'translate(-1px, 0px) rotate(5deg)', offset: .8 },
        { transform: 'translate(-2px, -6px) rotate(6.5deg)', offset: .9 },
        { transform: 'translate(-2px, 0px) rotate(4deg)' },
      ], { duration: 300, easing: 'linear', fill: 'forwards' })
    } else basin.style.transform = 'translate(-2px, 0px) rotate(4deg)'
    await at(300)
    root.dataset.hit = ''
    root.dataset.hurt = ''
    if (playful()) {
      squash(true)
      play(lane, kf([{ transform: 'none' }, { transform: 'translate(6px,2px)', offset: .16 }, { transform: 'translate(-5px,-1px)', offset: .34 }, { transform: 'translate(3px,1px)', offset: .52 }, { transform: 'translate(-1px,0)', offset: .72 }, { transform: 'none' }], 'linear'), { duration: 380, fill: 'none' })
    }
    // The basin settles with its own small bounce. Keep the contact for a beat: the hit has to
    // read before she reacts.
    await at(330)
    if (playful() && !reduced()) {
      drop(basin)
      basin.style.transform = 'translate(-2px, 0px) rotate(4deg)'
      play(basin, [
        { transform: 'translate(-2px, 0px) rotate(4deg)' },
        { transform: 'translate(-1px, -2px) rotate(2.8deg)', offset: .36 },
        { transform: 'translate(-2px, 0px) rotate(3.6deg)' },
      ], { duration: 420, easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'forwards' })
    }
    await at(420)
    // A small knockback: she is out on her feet for a moment, then falls back under the paper.
    if (playful()) {
      play(move, [
        { transform: 'translateY(0px)' },
        { transform: 'translateY(-10px) rotate(-2deg)', offset: .34 },
        { transform: 'translateY(0px) rotate(1deg)', offset: .7 },
        { transform: 'translateY(6px)', offset: .88 },
        { transform: 'translateY(4px)' },
      ], { duration: 220, easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'forwards' })
    }
    await at(620)
    // Knocked out: the hurt face stays; she falls straight through the middle and takes the
    // white sheet with her. The paper edge goes first, so nothing cuts her off at the rim.
    root.dataset.exit = 'caption all'
    root.dataset.drop = ''
    if (playful()) {
      to(move, { transform: 'translate(0px, 680px) rotate(7deg)' }, { duration: 820, easing: 'cubic-bezier(.4,0,.9,1)' })
    } else move.style.transform = 'translate(0px, 680px) rotate(7deg)'
    await at(1440)
    delete root.dataset.hit
    act('handoffShow')
    await at(1700)
    act('handoffDone')
  }
  // Reduced motion: the arcs' .12 s fill and the closed ring are seen before the content fades.
  async function stillHandoff(at) {
    delete root.dataset.hurt
    await at(300)
    root.dataset.exit = 'caption all lane'
    await at(420)
    act('handoffShow')
    await at(440)
    act('handoffDone')
  }
  // 1.25 x the whale's height: fully under the waterline within about 200 ms.
  const DEEP = () => Math.round(125 * u)
  function dive(dx, dy, deg, curve) {
    to(body, { scale: '1' }, curve)
    to(move, { transform: `translate(${dx}px, ${dy}px) rotate(${deg}deg)` }, curve)
  }

  // ---- pointer and keyboard focus ----
  hit.addEventListener('pointerenter', petStart)
  hit.addEventListener('pointerleave', petEnd)
  hit.addEventListener('click', spoutClick)

  // ---- answering a card: press anticipation, nod, lean released ----
  const answering = target => { const button = target?.closest?.('.card button[data-act]'); return button && !LOCAL.has(button.dataset.act) ? button : null }
  function unpress() {
    const button = D.press
    if (!button) return
    D.press = null
    button.removeEventListener('pointerleave', unpress)
    to(body, { scale: '1' }, spring('tap'))
  }
  document.addEventListener('pointerdown', (event) => {
    const button = answering(event.target)
    if (!button || event.button !== 0 || instant || !stirs() || D.handed || D.legging || ['down', 'lift', 'dive', 'sunk', 'enter'].includes(D.pose)) return
    unpress()
    D.press = button
    button.addEventListener('pointerleave', unpress)
    to(body, { scale: '1.03 .97' }, { duration: 120, easing: OUT })
  })
  document.addEventListener('pointercancel', unpress)
  // A press that ends without a click (the button went away under it) springs back too.
  document.addEventListener('pointerup', () => { if (D.press) setTimeout(unpress, 0) })
  // Capture phase: this runs before start.js sends the act, so a state that the act brings
  // drops the lean's return timer with the old token. The act itself is never delayed.
  document.addEventListener('click', (event) => {
    const button = answering(event.target)
    if (!button) return
    unpress()
    if (!stirs()) return
    const mine = token
    D.hopsStopped = true
    D.leanOff = true
    leanOut()
    // A card that stays (a model picked on the import card, logs opened) leans in again.
    later(mine, 1000, () => { D.leanOff = false; leanIn() })
    nod()
  }, true)

  // ---- reconcile ----
  async function step() {
    await entered
    if (want.view === 'handoff') return handoff()
    if (D.pose === 'enter') { D.pose = 'loop'; armActive() }
    if (D.over || want.station < D.checks) { D.over = false; await resetRun() }
    if (!failure() && ['down', 'lift', 'redo'].includes(D.pose)) await shakeOff()
    await runLegs()
    if (want.view === 'handoff') return handoff()
    if (copying() || (['boot', 'moving'].includes(want.view) && !holding())) armActive()
    if (failure()) {
      if (D.pose === 'redo') D.pose = 'loop'
      await goDown()
      if (['available', 'downloading', 'installing'].includes(want.update)) await lift()
      else if (want.update === 'failed' && D.pose === 'lift') { D.pose = 'loop'; await goDown() }
      return
    }
    if (want.view === 'card' || want.view === 'watchdog') return cardPose()
    return phaseLoop()
  }
  // A resumed page shows the arcs it catches up on without drawing them (start.css
  // html[data-resume]); once that has been painted, later arcs draw again.
  const caughtUp = () => requestAnimationFrame(() => requestAnimationFrame(() => delete root.dataset.resume))
  let pumping = false
  let again = false
  function kick() {
    again = true
    if (pumping) return
    pumping = true
    ;(async () => {
      try {
        while (again) { again = false; await step(); if (instant) caughtUp(); instant = false }
      } catch (error) { console.error(error) } finally { pumping = false; instant = false }
    })()
  }

  // The copy starts (start-window §6): the ring goes from three arcs to four, the import's arc
  // growing out of the gap after the data folder's while the others make room; it goes back to
  // three when the copy stops. The stages change at once, the drawing once the card has landed.
  function relayout(list) {
    const gone = phases.filter(phase => !list.includes(phase))
    phases = list
    for (const st of stations) st.hidden = !list.includes(st.dataset.phase)
    clearTimeout(activeTimer)
    for (const phase of gone) {
      const st = stations.find(entry => entry.dataset.phase === phase)
      st.dataset.state = 'pending'
      st.removeAttribute('aria-current')
      document.querySelector(`.arc[data-phase="${phase}"]`).dataset.state = 'pending'
      if (phase === 'import') importArc?.style.removeProperty('--f')
    }
    for (let i = D.checks; i < list.length; i += 1) setStation(i, 'pending')
    D.activeAt = D.activeAt.slice(0, D.checks)
    if (D.failed !== undefined && D.failed >= D.checks) D.failed = undefined
    if (D.flying) D.layoutDue = true
    else reshape()
  }
  // The arcs' angles as drawn, and the ring's re-layout between them: every frame of the shape
  // spring draws each arc between its old and new angles, so the arcs stay on the circle.
  let drawn = spansOf(PHASES)
  let shaping = 0
  function paint(spans) {
    drawn = spans
    for (const arc of document.querySelectorAll('.arc')) {
      const [from, to] = spans[arc.dataset.phase]
      for (const path of arc.querySelectorAll('path')) path.setAttribute('d', arcD(from, Math.max(from + 0.01, to)))
      arc.style.opacity = to - from < 1 ? String(Math.max(0, to - from)) : ''
    }
  }
  function reshape() {
    const target = spansOf(phases)
    const mine = (shaping += 1)
    paint(drawn)
    if (phases.length === 4) ring.dataset.n = '4'
    const done = () => { if (mine !== shaping) return; paint(target); if (phases.length !== 4) delete ring.dataset.n }
    if (instant || !D.started || root.hasAttribute('data-held') || reduced()) { done(); return }
    const from = drawn
    const curve = spring('shape')
    // A clock that does nothing but run the spring: its progress is the eased one.
    const clock = ring.animate([{ opacity: 1 }, { opacity: 1 }], { duration: curve.duration, easing: curve.easing })
    const frame = () => {
      if (mine !== shaping) { clock.cancel(); return }
      const t = clock.playState === 'finished' ? null : clock.effect.getComputedTiming().progress
      if (t === null) { done(); return }
      const mix = {}
      for (const phase of Object.keys(target)) mix[phase] = [0, 1].map(k => from[phase][k] + (target[phase][k] - from[phase][k]) * t)
      paint(mix)
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    setTimeout(done, curve.duration + 200)
  }
  let caughtTimer = 0

  return {
    update(s) {
      D.offer = s.explain?.mode === 'import'
      if (s.card?.kind === 'import') D.asked = true
      if (D.asked && (['copying', 'importFailed'].includes(s.card?.kind) || ['boot', 'moving', 'handoff', 'failed', 'viewFailed'].includes(s.view))) D.answered = true
      if (Array.isArray(s.phases) && s.phases.join() !== phases.join() && s.phases.every(phase => stations.some(st => st.dataset.phase === phase))) relayout(s.phases)
      const done = s.done ?? []
      const now = performance.now()
      phases.forEach((phase, k) => { if (done.includes(phase) && !want.done.includes(phase)) D.since[k + 1] = now })
      let station = 0
      while (station < last() && done.includes(phases[station])) station += 1
      if (holding()) station = Math.min(station, 1)
      if (typeof s.card?.arc === 'number') importArc?.style.setProperty('--f', s.card.arc.toFixed(3))
      const next = { station, view: s.view, phase: s.phase, done, card: s.card?.kind ?? '', missed: Boolean(s.card?.missedRetry), celebrate: Boolean(s.celebrate), update: s.update?.state ?? '', landing: s.landing ?? null }
      // Stages taken back mean a start in another folder: the whale starts over even when the
      // next snapshot, a moment later, has the first stage done again.
      if (D.started && station < want.station) D.over = true
      const changed = !D.started || ['station', 'view', 'phase', 'card', 'missed', 'update'].some(key => next[key] !== want[key])
      want = next
      D.started = true
      if (changed) { bump(); kick() }
    },
    slow(level) {
      if (level === D.slow) return
      const previous = D.slow
      D.slow = level
      if (level === 0) {
        for (const el of [loop, move]) for (const a of el.getAnimations()) if (a.playbackRate !== 1) a.updatePlaybackRate(1)
      }
      if (level === 1) calm()
      if (level === 2 || previous === 2) { bump(); kick() }
    },
    nod,
    // Resolves once arc i is done and drawn full (start.js shows the import card after the first).
    through(i) {
      return new Promise((resolve) => { if (D.passed > i) resolve(); else throughs.push([i, resolve]) })
    },
    // The card flies into the import's arc (start.js flyIn()): the arc lights up as it lands.
    flight(landed) {
      D.flying = true
      landed.then(() => {
        D.flying = false
        if (D.layoutDue) { D.layoutDue = false; reshape() }
        // Lit as it lands, even when the copy is done by then: it holds HOLD before it fills.
        const i = phases.indexOf('import')
        if (i >= 0 && D.at === i && stationEl(i).dataset.state === 'pending' && !failure() && !D.handed) {
          clearTimeout(activeTimer)
          showActive(i)
        }
        kick()
        if (!importArc || reduced()) return
        clearTimeout(caughtTimer)
        importArc.setAttribute('data-caught', '')
        caughtTimer = setTimeout(() => importArc.removeAttribute('data-caught'), 450)
      })
    },
    // Live switch of reduced motion or of the tier: running one-shots jump to their end.
    refresh() {
      stopBreath()
      D.press = null
      for (const el of [body, move, loop, lane, ripple]) for (const a of scripted(el)) settle(a, el)
      D.hop = null
      D.pet = null
      D.lean = false
      if (reduced()) {
        for (const el of [breathLayer, body, move, loop]) { for (const a of scripted(el)) a.cancel(); el.style.removeProperty('transform'); el.style.removeProperty('scale'); el.style.removeProperty('opacity') }
        return
      }
      if (['down', 'lift'].includes(D.pose)) D.pose = 'redo'
      D.loop = ''
      D.card = ''
      bump()
      kick()
    },
  }
}
