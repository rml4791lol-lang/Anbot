import { createElement as h, useLayoutEffect, useRef, useState } from 'react'
import { t } from './i18n.js'

export function AnswerQuestionLink({ turn }) {
  const anchor = useRef(null)
  const target = useRef(null)
  const [question, setQuestion] = useState('')
  useLayoutEffect(() => {
    const seat = anchor.current
    const flow = seat?.closest('[data-chat-flow]')
    const candidates = flow?.querySelectorAll(`[data-chat-turn="${Number(turn)}"][data-chat-flow-kind="user"]`) ?? []
    const message = Array.from(candidates).find(row =>
      row.closest('[data-chat-flow]') === flow && (row.compareDocumentPosition(seat) & Node.DOCUMENT_POSITION_FOLLOWING))
    target.current = message?.querySelector('[data-bt-question], [data-message-bubble]') ?? null
    const text = target.current?.dataset.btQuestion ?? target.current?.textContent ?? ''
    setQuestion(text.trim().replace(/\s+/gu, ' ').slice(0, 120))
  }, [turn])
  const jump = () => {
    if (!target.current?.isConnected) return
    if (!target.current.hasAttribute('tabindex')) target.current.tabIndex = -1
    target.current.focus({ preventScroll: true })
    target.current.scrollIntoView({ block: 'center', behavior: 'instant' })
  }
  return h('div', { ref: anchor, className: 'bt-question-link', hidden: question === '' },
    question ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: jump,
      title: question, 'aria-label': t('Back to question: {question}', { question }) },
    h('span', { 'aria-hidden': true }, '↑'), h('span', null, question)) : null)
}
