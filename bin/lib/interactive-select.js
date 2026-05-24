import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const OPTIONS = [
  {
    value: 'project',
    label: 'Project install',
    description: "Install into this repository's .codex directory",
  },
  {
    value: 'user',
    label: 'User install',
    description: 'Install into ~/.codex for all Codex projects',
  },
  {
    value: 'cancel',
    label: 'Cancel',
    description: '',
  },
];

export async function selectInstallTarget({
  cwd = process.cwd(),
  input = process.stdin,
  output = process.stdout,
} = {}) {
  let selectedIndex = await hasCodexDir(cwd) ? 0 : 1;

  readline.emitKeypressEvents(input);
  const canSetRawMode = typeof input.setRawMode === 'function';
  if (canSetRawMode) {
    input.setRawMode(true);
  }
  input.resume();
  render(output, selectedIndex, false);

  return new Promise((resolve) => {
    const finish = (value) => {
      input.off('keypress', onKeypress);
      if (canSetRawMode) {
        input.setRawMode(false);
      }
      output.write('\n');
      resolve(value);
    };

    const onKeypress = (_text, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        finish('cancel');
        return;
      }
      if (key.name === 'up') {
        selectedIndex = (selectedIndex + OPTIONS.length - 1) % OPTIONS.length;
        render(output, selectedIndex, true);
        return;
      }
      if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % OPTIONS.length;
        render(output, selectedIndex, true);
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish(OPTIONS[selectedIndex].value);
      }
    };

    input.on('keypress', onKeypress);
  });
}

async function hasCodexDir(cwd) {
  try {
    const stat = await fs.stat(path.join(cwd, '.codex'));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function render(output, selectedIndex, rerender) {
  if (rerender) {
    output.write('\x1b[5A\x1b[J');
  }

  const lines = [
    'Where should Superharness Codex support be installed?',
    '',
    ...OPTIONS.map((option, index) => {
      const prefix = index === selectedIndex ? '>' : ' ';
      return `${prefix} ${option.label.padEnd(16)}${option.description}`;
    }),
  ];

  output.write(`${lines.join('\n')}\n`);
}
