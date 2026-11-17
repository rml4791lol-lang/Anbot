// The window's own versions of the DSH interface primitives the Bot views draw with (see
// ds-bot/src/client/dsh-primitives.js and vite.config.js).
import { createElement as h, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatsIcon, DownloadIcon, GearIcon, PeopleIcon, SlidersIcon, StarLineIcon } from '../../../ds-bot/src/client/icons.js'
import { MENTION_ORIGIN } from '../../../ds-bot/src/client/text.js'

// The DSH Agent's mark. The app has no DSH Agent, so nothing asks for it.
export const FishLogo = () => null

// writeClipboard in the plugin is DSH's (navigator.clipboard with an execCommand
// fallback off-HTTPS); the window keeps the same contract.
export const writeClipboard = text => (navigator.clipboard === undefined
  ? Promise.resolve(document.execCommand('copy', false, text))
  : navigator.clipboard.writeText(text).then(() => true, () => false))

const plugins = [remarkGfm]

function CodeBlock({ children, labels }) {
  const [copied, setCopied] = useState(false)
  const block = useRef(null)
  const copy = () => {
    void navigator.clipboard?.writeText(block.current?.innerText ?? '').then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    })
  }
  return h('div', { className: 'md-code' },
    h('button', { type: 'button', className: 'md-copy', onClick: copy }, copied ? labels?.code?.copiedLabel : labels?.code?.copyLabel),
    h('pre', { ref: block }, children))
}

// Links open outside the window; mention links stay for the chat's own click handler.
const elements = labels => ({
  a: ({ node: _node, ...props }) => h('a', props.href?.startsWith(MENTION_ORIGIN) ? props : { ...props, target: '_blank', rel: 'noreferrer' }),
  pre: ({ children }) => h(CodeBlock, { labels }, children),
})

// The class keeps the `_markdown` stem that the Bot views' styles give DSH's Markdown.
export function MarkdownText({ text, labels, variant }) {
  // New element types on every render would remount each code block as a reply streams in.
  const components = useMemo(() => elements(labels), [labels?.code?.copyLabel, labels?.code?.copiedLabel])
  return h('div', { className: variant === 'compact' ? 'md_markdown md-compact' : 'md_markdown' },
    h(Markdown, { remarkPlugins: plugins, components }, text ?? ''))
}

export const projectUserText = text => text

export const fileExtension = name => {
  const part = String(name ?? '').split('.').at(-1)
  return part === String(name ?? '') || part === undefined ? '' : part
}

export const fileSizeText = bytes => {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1000) return `${String(bytes)} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`
}

export const FileTypeIcon = ({ path, className }) => h('span', { className, 'aria-hidden': true }, (fileExtension(path) || 'file').slice(0, 4).toUpperCase())

export function JsonBlock({ label, payload }) {
  return h('details', { className: 'md-json' },
    label ? h('summary', null, label) : null,
    h('pre', null, JSON.stringify(payload, null, 2)))
}

export function Button({ variant = 'ghost', size = 'md', icon, className, children, ...rest }) {
  const classes = [variant === 'primary' ? 'bt-send' : 'bt-soft', size === 'sm' ? 'bt-soft-sm' : '', className].filter(Boolean).join(' ')
  return h('button', { type: 'button', className: classes, ...rest },
    icon === undefined ? null : h('span', { className: 'ui-button-icon', 'aria-hidden': true }, icon),
    children)
}

export function ConnectionIndicator({ state, disconnectedLabel, connectingLabel, recoveredLabel, reconnectActionLabel, restartActionLabel, onReconnect }) {
  if (state === undefined) return null
  if (state === 'recovered') return h('span', { role: 'status', className: 'bt-soft bt-soft-sm' }, recoveredLabel)
  const connecting = state === 'connecting'
  return h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-label': connecting ? restartActionLabel : reconnectActionLabel, onClick: onReconnect },
    connecting ? connectingLabel : disconnectedLabel)
}

export function Tooltip({ disabled = false, label, shortcutKeys, children }) {
  if (disabled || label === undefined || label === null) return children
  const keys = Array.isArray(shortcutKeys) ? shortcutKeys.join('+') : shortcutKeys
  return h('span', { className: 'ui-tooltip', title: keys === undefined ? label : `${label} (${keys})` }, children)
}

export function Modal({ open, onClose, title, closeLabel, description, children, footer, className, onKeyDownCapture }) {
  if (!open) return null
  return createPortal(h('div', { className: 'ui-modal-root', role: 'presentation', onKeyDownCapture: onKeyDownCapture },
    h('div', { className: 'ui-modal-mask', 'aria-hidden': true, onClick: onClose }),
    h('div', { className: ['ui-modal-dialog', className].filter(Boolean).join(' '), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { className: 'ui-modal-header' },
        h('h2', null, title),
        closeLabel === undefined ? null : h('button', { type: 'button', className: 'ui-modal-close', 'aria-label': closeLabel, onClick: onClose }, '×')),
      description ? h('p', { className: 'ui-modal-description' }, description) : null,
      h('div', { className: 'ui-modal-body' }, children),
      footer === undefined ? null : h('div', { className: 'ui-modal-footer' }, footer))), document.body)
}

export const IconAgentPresetOutlineMedium = StarLineIcon
export const IconArchiveOutlineMedium = ChatsIcon
export const IconDownloadOutlineRegular = DownloadIcon
export const IconPersonalizationOutlineMedium = SlidersIcon
export const IconSettingsOutlineMedium = GearIcon
export const IconUserOutlineMedium = PeopleIcon
export const IconLoadingOutlineRegular = () => h('span', { className: 'ui-spin', 'aria-hidden': true }, '…')
