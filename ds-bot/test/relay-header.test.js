import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewOf, stripHeader, stripInternalText } from '../src/client/text.js'

test('relay headers with brackets in a Bot or group name leave the body intact', () => {
  const body = 'Hello [team]\n[notes](https://example.test)\n[Keep this line]'
  for (const name of ['Writer', 'R]2', 'A]B]C', 'A[B]C', '[Ops]', '普通[助理]']) {
    for (const header of [
      `[Message from ${name}]`,
      `[Reply from ${name}]`,
      `[Group post from ${name}]`,
      `[Group chat "${name}" · replies to your post]`,
      `[Reply from Writer · for the work ${name} asked you for; your answer goes to ${name} once everything you handed on is back]`,
    ]) {
      assert.equal(stripHeader(`${header}\n${body}`), body, header)
      assert.equal(stripHeader(`${header}\r\n${body}`), body, header)
    }
  }
})

test('a single-line relay keeps its inline body, including later brackets', () => {
  for (const header of ['[Message from Writer]', '[Group post from Writer]', '[Bot team setup]']) {
    assert.equal(stripHeader(`${header} Hello [team]`), ' Hello [team]')
    assert.equal(stripHeader(header), '')
  }
})

test('a header strip never reaches into a later body line or unrelated bracketed text', () => {
  for (const text of ['[Message from Writer\n[Keep this line]', '[Someone else]\nHello', 'Hello\n[Message from Writer]']) {
    assert.equal(stripHeader(text), text)
  }
})

test('internal control notices are removed from replies and sidebar previews', () => {
  assert.equal(stripInternalText('收到：[SCHEDULE CHANGE] A task changed.\nA scheduled task involving this session was updated.\nShip it.'), 'Ship it.')
  assert.equal(stripInternalText('收到：[SCHEDULE REMINDER] ping'), '')
  assert.equal(stripInternalText('[Your profile was updated — follow the latest version] Your role changed.'), '')
  const list = {
    byId: {
      b: {
        projectionValues: {
          turnOutline: [
            { turn: 1, prompt: '[SCHEDULE REMINDER] raw task prompt' },
            { turn: 2, response: '收到：[SCHEDULE CHANGE] A task changed.\nShip it.' },
          ],
        },
      },
    },
  }
  assert.equal(previewOf(list, 'b'), 'Ship it.')
})
