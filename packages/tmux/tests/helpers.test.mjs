import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = join(packageRoot, 'skills/tmux/scripts');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

function fields(output) {
  return Object.fromEntries(output.trim().split('\n').filter(line => line.includes('='))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
}

function fixture(run) {
  // /tmp keeps Unix socket paths short even on macOS. Never use personal sockets.
  const root = mkdtempSync('/tmp/wb-tmux-');
  const home = join(root, 'home');
  mkdirSync(home);
  const socket = join(root, 'worker.sock');
  const observer = join(root, 'observer.sock');
  const env = { ...process.env, HOME: home, SHELL: '/bin/sh', TMUX: '', TMUX_PANE: '',
    TMUX_SKILL_SOCKET_DIR: root };
  const owned = [];
  const command = (targetSocket, ...args) => spawnSync('tmux',
    ['-f', '/dev/null', '-S', targetSocket, ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 5000 });
  const ok = result => {
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const sessions = targetSocket => {
    const result = command(targetSocket, 'list-sessions', '-F', '#{session_id}');
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').sort();
  };
  const remove = item => command(item.socket, item.kind, '-t', item.id);
  const helper = (name, ...args) => {
    const result = spawnSync(join(scripts, name), args,
      { cwd: root, env, encoding: 'utf8', timeout: 5000 });
    // Record only creation output, even if a later observer step failed.
    if (name === 'start-session.sh') {
      const data = fields(result.stdout || '');
      if (/^\$\d+$/.test(data.SESSION_ID)) {
        owned.push({ socket: data.SOCKET, kind: 'kill-session', id: data.SESSION_ID });
      }
      if (/^%\d+$/.test(data.OBSERVER_PANE_ID)) {
        owned.push({ socket: data.OBSERVER_SOCKET,
          kind: data.OBSERVER_KIND === 'window' ? 'kill-window' : 'kill-pane',
          id: data.OBSERVER_KIND === 'window' ? data.OBSERVER_WINDOW_ID : data.OBSERVER_PANE_ID });
      }
    }
    assert.ifError(result.error);
    return result;
  };
  try {
    const createGuard = targetSocket => {
      const id = ok(command(targetSocket, 'new-session', '-d', '-s', 'unrelated',
        '-P', '-F', '#{session_id}'));
      owned.push({ socket: targetSocket, kind: 'kill-session', id });
      return id;
    };
    const guard = createGuard(socket);
    const observerGuard = createGuard(observer);
    const observerTarget = ok(command(observer, 'list-panes', '-t', observerGuard, '-F', '#{pane_id}'));
    const start = (...args) => fields(ok(helper('start-session.sh', '-s', 'test', '-S', socket, ...args)));
    run({ socket, observer, guard, observerGuard, observerTarget, command, helper, start, ok, sessions });
  } finally {
    const errors = [];
    // Observers were recorded after their workers, so reverse order closes them first.
    for (const item of [...owned].reverse()) {
      const result = remove(item);
      if (result.error) errors.push(`${item.socket} ${item.id}: ${result.error.message}`);
      // An already-removed resource is fine; verify absence independently below.
    }
    for (const targetSocket of new Set([observer, socket, ...owned.map(item => item.socket)])) {
      const result = command(targetSocket, 'list-sessions', '-F', '#{session_id}');
      if (result.error || result.status === 0 || result.stdout.trim()) {
        errors.push(`Cleanup unconfirmed on ${targetSocket}: ${result.stdout} ${result.error || ''}`);
      }
    }
    // Preserve the socket directory and diagnostics if exact-resource cleanup failed.
    assert.deepEqual(errors, [], errors.join('\n'));
    rmSync(root, { recursive: true, force: true });
  }
}

test('skills-only manifest, local references, executable scripts, and shell syntax', () => {
  assert.deepEqual(manifest.pi, { skills: ['./skills'] });
  assert.deepEqual(manifest.files, ['skills/']);
  for (const name of ['start-session.sh', 'wait-for-text.sh', 'find-sessions.sh']) {
    assert.ok(statSync(join(scripts, name)).mode & 0o111, `${name} must be executable`);
    const result = spawnSync('bash', ['-n', join(scripts, name)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const name of ['SKILL.md', 'ADVANCED.md']) {
    const text = readFileSync(join(packageRoot, 'skills/tmux', name), 'utf8');
    for (const [, link] of text.matchAll(/\]\(([^)]+)\)/g)) {
      assert.ok(statSync(join(packageRoot, 'skills/tmux', link)).isFile());
    }
  }
  assert.match(readFileSync(join(packageRoot, 'skills/tmux/SKILL.md'), 'utf8'), /^---\nname: tmux\ndescription: .+\n---/);
});

test('creation returns exact IDs; repeated names never reuse sessions; cleanup preserves guard', () => fixture(t => {
  const first = t.start();
  const second = t.start();
  assert.match(first.SESSION_ID, /^\$\d+$/);
  assert.match(first.WINDOW_ID, /^@\d+$/);
  assert.match(first.PANE_ID, /^%\d+$/);
  assert.equal(first.SOCKET, t.socket);
  assert.notEqual(first.SESSION_ID, second.SESSION_ID);
  t.ok(t.command(t.socket, 'kill-session', '-t', first.SESSION_ID));
  assert.deepEqual(t.sessions(t.socket), [t.guard, second.SESSION_ID].sort());
  t.ok(t.command(t.socket, 'kill-session', '-t', second.SESSION_ID));
  assert.deepEqual(t.sessions(t.socket), [t.guard]);
}));

for (const kind of ['window', 'pane']) {
  test(`${kind} observer cleanup preserves its original host pane`, () => fixture(t => {
    const data = t.start('--visible', '--observer-socket', t.observer, '--observer-target',
      t.observerTarget, '--display-mode', kind);
    assert.equal(data.OBSERVER_KIND, kind);
    assert.notEqual(data.OBSERVER_PANE_ID, t.observerTarget);
    assert.equal(data.OBSERVER_SOCKET, t.observer);
    t.ok(t.command(t.observer, kind === 'window' ? 'kill-window' : 'kill-pane', '-t',
      kind === 'window' ? data.OBSERVER_WINDOW_ID : data.OBSERVER_PANE_ID));
    t.ok(t.command(t.socket, 'kill-session', '-t', data.SESSION_ID));
    assert.deepEqual(t.sessions(t.socket), [t.guard]);
    assert.equal(t.ok(t.command(t.observer, 'list-panes', '-t', t.observerGuard, '-F', '#{pane_id}')),
      t.observerTarget);
  }));
}

test('observer startup failure removes only its worker', () => fixture(t => {
  const result = t.helper('start-session.sh', '-s', 'test', '-S', t.socket, '--visible',
    '--observer-socket', t.observer, '--observer-target', '%999999');
  assert.notEqual(result.status, 0);
  assert.deepEqual(t.sessions(t.socket), [t.guard]);
  assert.equal(t.ok(t.command(t.observer, 'list-panes', '-t', t.observerGuard, '-F', '#{pane_id}')),
    t.observerTarget);
}));

test('missing values and implicit observer targets fail without creating sessions', () => fixture(t => {
  for (const [name, option] of [['start-session.sh', '--session'], ['start-session.sh', '--command'],
    ['start-session.sh', '--observer-target'], ['wait-for-text.sh', '--pattern'],
    ['wait-for-text.sh', '--timeout'], ['find-sessions.sh', '--socket-path'], ['find-sessions.sh', '--query']]) {
    for (const tail of [[], ['--help']]) {
      const result = t.helper(name, option, ...tail);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(`Missing value for ${option}`), result.stderr);
    }
  }
  const result = t.helper('start-session.sh', '-s', 'test', '-S', t.socket, '--visible');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--observer-socket/);
  assert.deepEqual(t.sessions(t.socket), [t.guard]);
}));

test('wait observes literal output; timeout is diagnostic and preserves caller sessions', () => fixture(t => {
  const data = t.start('--command', "printf 'ready-literal.*\\n'; exec /bin/sh");
  t.ok(t.helper('wait-for-text.sh', '-S', t.socket, '-t', data.PANE_ID,
    '--fixed', '-p', 'ready-literal.*', '-T', '2'));
  const before = performance.now();
  const result = t.helper('wait-for-text.sh', '-S', t.socket, '-t', data.PANE_ID,
    '--fixed', '-p', 'never-printed-token', '-T', '1', '-i', '0.05');
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /diagnostics only/);
  assert.ok(performance.now() - before < 3000);
  assert.deepEqual(t.sessions(t.socket), [t.guard, data.SESSION_ID].sort());
}));

test('invalid waits and capture errors are not hidden as timeouts', () => fixture(t => {
  for (const [args, message] of [
    [['-t', '%999999', '-p', 'foo'], /Cannot capture pane/],
    [['-t', 'unrelated', '-p', 'foo'], /pane ID/],
    [['-t', '%0', '-p', '['], /Invalid regex/],
    [['-t', '%0', '-p', 'foo', '-T', '900'], /timeout/],
    [['-t', '%0', '-p', 'foo', '-i', '-1'], /interval/],
  ]) {
    const result = t.helper('wait-for-text.sh', '-S', t.socket, ...args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, message);
  }
  assert.deepEqual(t.sessions(t.socket), [t.guard]);
}));

test('discovery selects only the private socket; queries are literal, case-insensitive', () => fixture(t => {
  // Fixture default socket is distinct from the explicit worker socket.
  const data = fields(t.ok(t.helper('start-session.sh', '-s', 'Private')));
  const result = t.helper('find-sessions.sh');
  t.ok(result);
  assert.ok(result.stdout.includes(`${data.SESSION_ID} ${data.SESSION}`));
  assert.ok(!result.stdout.includes('unrelated'));
  const match = t.helper('find-sessions.sh', '-S', t.socket, '-q', 'UNRELATED');
  assert.match(t.ok(match), /unrelated/);
  const literal = t.helper('find-sessions.sh', '-S', t.socket, '-q', 'unrelated.*');
  assert.match(t.ok(literal), /No sessions/);
  assert.deepEqual(t.sessions(t.socket), [t.guard]);
}));
