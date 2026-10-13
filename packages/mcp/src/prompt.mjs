import { StringDecoder } from 'node:string_decoder';
import { AuthError } from './errors.mjs';

const interactiveRequired = () => new AuthError('INTERACTIVE_LOGIN_REQUIRED', 'Run --login in a local interactive terminal.');
const cancelled = () => new AuthError('LOGIN_CANCELLED', 'Login cancelled.');

export async function promptCredentials({ input = process.stdin, output = process.stderr } = {}) {
  if (input?.isTTY !== true || output?.isTTY !== true || typeof input.setRawMode !== 'function') {
    throw interactiveRequired();
  }

  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing === true;
  const decoder = new StringDecoder('utf8');
  return new Promise((resolve, reject) => {
    let email = '', password = '', field = 'email', skipLF = false, finished = false, rawAttempted = false;
    let escape = '', pasting = false, pastedText = '', bracketedPasteEnabled = false;
    const cancel = () => finish(cancelled());
    const outputFailed = () => { bracketedPasteEnabled = false; cancel(); };

    function finish(error, credentials) {
      if (finished) return;
      finished = true;
      input.removeListener('data', onData);
      for (const event of ['error', 'end', 'close']) input.removeListener(event, cancel);
      output.removeListener('error', outputFailed);
      for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, cancel);
      try { if (bracketedPasteEnabled) output.write('\u001b[?2004l'); }
      catch { error = interactiveRequired(); }
      try {
        input.pause();
        if (rawAttempted) input.setRawMode(wasRaw);
        if (wasFlowing) input.resume();
      } catch { error = interactiveRequired(); }
      email = password = pastedText = '';
      if (error) reject(error);
      else resolve(credentials);
    }

    function onData(chunk) {
      try {
        let text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
        if (!text) return;
        if (skipLF) {
          skipLF = false;
          if (text.startsWith('\n')) text = text.slice(1);
        }
        if (!text) return;
        // A text chunk with a newline may be a paste spanning both prompts.
        // Reject it before echoing any part or advancing to the next field.
        if (/[\r\n]/.test(text) && (pasting || !/^(?:\r\n|\r|\n)$/.test(text))) {
          finish(new AuthError('LOGIN_CANCELLED', 'Login cancelled: enter each field separately; multiline paste is not supported.'));
          return;
        }
        if (/^(?:\r\n|\r|\n)$/.test(text)) {
          skipLF = text === '\r';
          output.write('\n');
          if (field === 'email') {
            email = email.trim();
            if (!email) output.write('Email is required.\nEmail: ');
            else { field = 'password'; output.write('Password: '); }
          } else if (!password) output.write('Password is required.\nPassword: ');
          else finish(undefined, { email, password });
          return;
        }
        for (const character of text) {
          if (character === '\u0003' || character === '\u0004') { cancel(); return; }
          if (escape) {
            escape += character;
            if (escape === '\u001b[' || escape === '\u001bO') continue;
            if (escape.length > 32 || escape[1] !== '[' || /[@-~]/.test(character)) {
              if (escape === '\u001b[200~') { pasting = true; pastedText = ''; }
              else if (escape === '\u001b[201~' && pasting) {
                pasting = false;
                for (const pastedCharacter of pastedText) append(pastedCharacter);
                pastedText = '';
              } else if (escape === '\u001b[3~' && !pasting) erase();
              escape = '';
            }
          } else if (character === '\u001b') escape = character;
          else if (pasting) {
            if (character >= ' ' && character !== '\u007f') pastedText += character;
          } else if (character === '\b' || character === '\u007f') erase();
          else append(character);
        }
      } catch { cancel(); }
    }

    function append(character) {
      if (character >= ' ' && character !== '\u007f') {
        if (field === 'email') { email += character; output.write(character); }
        else password += character;
      }
    }

    function erase() {
      if (field === 'email' && email) {
        email = Array.from(email).slice(0, -1).join('');
        output.write('\b \b');
      } else if (field === 'password') password = Array.from(password).slice(0, -1).join('');
    }

    input.on('data', onData);
    for (const event of ['error', 'end', 'close']) input.on(event, cancel);
    output.on('error', outputFailed);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, cancel);
    try {
      rawAttempted = true;
      input.setRawMode(true);
      input.resume();
      bracketedPasteEnabled = true;
      output.write('\u001b[?2004hEmail: ');
    } catch { finish(interactiveRequired()); }
  });
}
