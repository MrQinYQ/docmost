import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promptCredentials } from '../src/prompt.mjs';

class Terminal extends EventEmitter {
  isTTY = true;
  isRaw = false;
  readableFlowing = null;
  rawModes = [];
  written = '';
  setRawMode(value) { this.isRaw = value; this.rawModes.push(value); }
  isPaused() { return this.readableFlowing === false; }
  pause() { this.readableFlowing = false; }
  resume() { this.readableFlowing = true; }
  write(value) { this.written += value; return true; }
  type(value) { this.emit('data', Buffer.from(value)); }
}

function terminals() { return { input: new Terminal(), output: new Terminal() }; }

test('terminal login echoes email but returns a password without echo or masking', async () => {
  const { input, output } = terminals();
  const result = promptCredentials({ input, output });
  input.type('person@example.test');
  input.type('\r');
  const passwordPrompt = output.written;
  input.type('synthetic-hidden-input');
  assert.equal(output.written, passwordPrompt);
  input.type('\r');
  assert.deepEqual(await result, { email: 'person@example.test', password: 'synthetic-hidden-input' });
  assert.ok(output.written.includes('person@example.test'));
  assert.ok(!output.written.includes('synthetic-hidden-input'));
  assert.ok(!output.written.includes('*'));
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.readableFlowing, false);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('error'), 0);
  assert.equal(output.listenerCount('error'), 0);
});

test('terminal login refuses pipes or a TTY without raw mode before reading or prompting', async () => {
  for (const unavailable of ['input', 'output', 'rawMode']) {
    const { input, output } = terminals();
    if (unavailable === 'input') input.isTTY = false;
    if (unavailable === 'output') output.isTTY = false;
    if (unavailable === 'rawMode') input.setRawMode = undefined;
    await assert.rejects(promptCredentials({ input, output }), { code: 'INTERACTIVE_LOGIN_REQUIRED' });
    assert.equal(output.written, '');
    assert.equal(input.listenerCount('data'), 0);
    assert.deepEqual(input.rawModes, []);
  }
});

test('blank entries are retried and email is trimmed without trimming a nonempty password', async () => {
  const { input, output } = terminals();
  const result = promptCredentials({ input, output });
  input.type('   ');
  input.type('\n');
  input.type(' person@example.test ');
  input.type('\n');
  input.type('\n');
  input.type('  ');
  input.type('\n');
  assert.deepEqual(await result, { email: 'person@example.test', password: '  ' });
});

test('backspace and delete edit both fields while hidden Unicode input stays hidden', async () => {
  const { input, output } = terminals();
  const result = promptCredentials({ input, output });
  input.type('person@example.testx');
  input.type('\b');
  input.type('\r');
  const passwordPrompt = output.written;
  const bytes = Buffer.from('密碼😀');
  input.emit('data', bytes.subarray(0, 1));
  input.emit('data', bytes.subarray(1));
  input.type('\u007f');
  input.type('x');
  input.type('\b');
  assert.equal(output.written, passwordPrompt);
  input.type('\r');
  assert.deepEqual(await result, { email: 'person@example.test', password: '密碼' });
});

test('CRLF and a split trailing LF advance to the password only once', async () => {
  for (const split of [false, true]) {
    const { input, output } = terminals();
    const result = promptCredentials({ input, output });
    input.type('person@example.test');
    if (split) { input.type('\r'); input.type('\n'); }
    else input.type('\r\n');
    const passwordPrompt = output.written;
    assert.ok(!passwordPrompt.includes('required'));
    input.type('synthetic-hidden-input');
    assert.equal(output.written, passwordPrompt);
    input.type('\r\n');
    assert.deepEqual(await result, { email: 'person@example.test', password: 'synthetic-hidden-input' });
  }
});

test('ambiguous pasted newlines cannot expose or silently submit credentials', async () => {
  for (const pasted of ['person@example.test\rsynthetic-hidden-input\r', 'person@example.test\n', '\n\n']) {
    const { input, output } = terminals();
    const result = promptCredentials({ input, output });
    const prompt = output.written;
    input.type(pasted);
    await assert.rejects(result, { code: 'LOGIN_CANCELLED' });
    assert.equal(output.written.replace(/\u001b\[\?2004[hl]/g, ''), prompt.replace(/\u001b\[\?2004[hl]/g, ''));
    assert.ok(!output.written.includes('synthetic-hidden-input'));
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('data'), 0);
  }
  const { input, output } = terminals();
  const result = promptCredentials({ input, output });
  input.type('person@example.test');
  input.type('\r');
  input.type('synthetic-hidden-input\n');
  await assert.rejects(result, { code: 'LOGIN_CANCELLED' });
  assert.ok(!output.written.includes('synthetic-hidden-input'));
});

test('Ctrl+C and Ctrl+D cancel either prompt and remove all prompt listeners', async () => {
  for (const field of ['email', 'password']) {
    for (const key of ['\u0003', '\u0004']) {
      const { input, output } = terminals();
      const signalsBefore = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
      const result = promptCredentials({ input, output });
      if (field === 'password') { input.type('person@example.test'); input.type('\r'); }
      input.type('synthetic-unsubmitted-input');
      input.type(key);
      await assert.rejects(result, error => error.code === 'LOGIN_CANCELLED' && !error.message.includes('synthetic-unsubmitted-input'));
      assert.equal(input.isRaw, false);
      assert.equal(input.readableFlowing, false);
      for (const event of ['data', 'error', 'end', 'close']) assert.equal(input.listenerCount(event), 0);
      assert.equal(output.listenerCount('error'), 0);
      assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), signalsBefore);
    }
  }
});

test('stream errors, stream termination and process signals cancel with sanitized errors', async () => {
  for (const failure of ['inputError', 'outputError', 'end', 'close', 'SIGINT', 'SIGTERM']) {
    const { input, output } = terminals();
    const signalsBefore = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
    const result = promptCredentials({ input, output });
    input.type('person@example.test');
    input.type('\r');
    if (failure === 'inputError') input.emit('error', new Error('synthetic-hidden-input'));
    else if (failure === 'outputError') output.emit('error', new Error('synthetic-hidden-input'));
    else if (failure.startsWith('SIG')) process.emit(failure);
    else input.emit(failure);
    await assert.rejects(result, error => error.code === 'LOGIN_CANCELLED' && !error.message.includes('synthetic-hidden-input'));
    assert.equal(input.isRaw, false);
    assert.equal(input.readableFlowing, false);
    assert.equal(input.listenerCount('data'), 0);
    assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), signalsBefore);
  }
});

test('a failed output stream is not written again during terminal cleanup', async () => {
  const { input, output } = terminals();
  const result = promptCredentials({ input, output });
  const beforeError = output.written;
  output.emit('error', new Error('synthetic-output-error'));
  await assert.rejects(result, { code: 'LOGIN_CANCELLED' });
  assert.equal(output.written, beforeError);
  assert.equal(input.isRaw, false);
  assert.equal(output.listenerCount('error'), 0);
});

test('successful and cancelled prompts restore a pre-existing raw and flowing terminal', async () => {
  for (const cancel of [false, true]) {
    const { input, output } = terminals();
    input.isRaw = true;
    input.resume();
    const result = promptCredentials({ input, output });
    if (cancel) {
      input.type('\u0003');
      await assert.rejects(result, { code: 'LOGIN_CANCELLED' });
    } else {
      input.type('person@example.test'); input.type('\r');
      input.type('synthetic-hidden-input'); input.type('\r');
      await result;
    }
    assert.equal(input.isRaw, true);
    assert.equal(input.readableFlowing, true);
    assert.deepEqual(input.rawModes, [true, true]);
  }
});

test('raw-mode or output setup errors restore the terminal and never expose error details', async () => {
  for (const failure of ['rawMode', 'write']) {
    const { input, output } = terminals();
    if (failure === 'rawMode') {
      input.setRawMode = function(value) {
        Terminal.prototype.setRawMode.call(this, value);
        if (value) throw new Error('synthetic-hidden-input');
      };
    } else output.write = () => { throw new Error('synthetic-hidden-input'); };
    await assert.rejects(promptCredentials({ input, output }), error =>
      error.code === 'INTERACTIVE_LOGIN_REQUIRED' && !error.message.includes('synthetic-hidden-input'));
    assert.equal(input.isRaw, false);
    assert.equal(input.readableFlowing, false);
    assert.equal(input.listenerCount('data'), 0);
  }
});

test('bracketed paste split across chunks stays hidden and requires a separate Enter', async () => {
  const { input, output } = terminals();
  const result = promptCredentials({ input, output });
  for (const chunk of ['\u001b[20', '0~', 'person@example.test', '\u001b[201~']) input.type(chunk);
  input.type('\r');
  const passwordPrompt = output.written;
  for (const chunk of ['\u001b[200~', 'synthetic-', 'hidden-input', '\u001b[201~']) input.type(chunk);
  assert.equal(output.written, passwordPrompt);
  input.type('\r');
  assert.deepEqual(await result, { email: 'person@example.test', password: 'synthetic-hidden-input' });
});

test('multiline bracketed paste cannot advance either field even when its newline arrives separately', async () => {
  for (const passwordField of [false, true]) {
    const { input, output } = terminals();
    const result = promptCredentials({ input, output });
    if (passwordField) { input.type('person@example.test'); input.type('\r'); }
    const prompt = output.written;
    input.type('\u001b[200~');
    input.type('synthetic-unsubmitted-input');
    input.type('\r');
    await assert.rejects(result, { code: 'LOGIN_CANCELLED' });
    assert.equal(output.written.replace(/\u001b\[\?2004[hl]/g, ''), prompt.replace(/\u001b\[\?2004[hl]/g, ''));
    assert.equal(input.isRaw, false);
  }
});

test('Delete and arrow escape sequences cannot become credential text', async () => {
  const { input, output } = terminals();
  const result = promptCredentials({ input, output });
  input.type('person@example.testx');
  input.type('\u001b[3~');
  input.type('\r');
  input.type('synthetic-hidden-inputx');
  input.type('\u001b[');
  input.type('3~');
  input.type('\u001b[D');
  input.type('\r');
  assert.deepEqual(await result, { email: 'person@example.test', password: 'synthetic-hidden-input' });
});
