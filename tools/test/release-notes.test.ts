import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { noteOf, prNumbers, readSubjects, releaseNotes } from '../release-notes.mjs';

describe('noteOf', () => {
  it('reads the note line in its usual forms', () => {
    expect(noteOf('Closes #1\n\nRelease note (vi): Xuất phiếu thu sang MISA.\n')).toBe('Xuất phiếu thu sang MISA.');
    expect(noteOf('**Release note (vi):** Tải hóa đơn bằng email.')).toBe('Tải hóa đơn bằng email.');
    expect(noteOf('- release note (vi):   Sửa   lỗi  chi nhánh ')).toBe('Sửa lỗi chi nhánh');
  });

  it('treats a missing, empty or "none" note as internal', () => {
    expect(noteOf(null)).toBeNull();
    expect(noteOf('Closes #1\n\nNo note here.')).toBeNull();
    expect(noteOf('Release note (vi):')).toBeNull();
    expect(noteOf('Release note (vi): <!-- one line for the partner, or leave empty -->')).toBeNull();
    expect(noteOf('Release note (vi): -')).toBeNull();
    expect(noteOf('Release note (vi): Không.')).toBeNull();
    expect(noteOf('Release note (vi): none')).toBeNull();
  });

  it('lets no HTML through, nested or unclosed comments included', () => {
    expect(noteOf('Release note (vi): <!--<!-- x -->--> Sửa lỗi')).toBe('--&gt; Sửa lỗi');
    expect(noteOf('Release note (vi): Sửa <b>lỗi</b>')).toBe('Sửa &lt;b&gt;lỗi&lt;/b&gt;');
    expect(noteOf('Release note (vi): Sửa lỗi <!-- chưa đóng')).toBe('Sửa lỗi');
    expect(noteOf('Release note (vi): <<!---->!-- ẩn -->')).toBeNull();
  });

  it('keeps one line and bounds its length', () => {
    expect(noteOf('Release note (vi): Dòng một\nDòng hai')).toBe('Dòng một');
    expect(noteOf(`Release note (vi): ${'a'.repeat(400)}`)).toHaveLength(300);
  });
});

describe('prNumbers', () => {
  it('takes the trailing PR number of squash merges, oldest first, once each', () => {
    const subjects = [
      'feat(app): a guide for accounting firms (#661) (#663)',
      'Merge branch main',
      'fix(finance): branch codes (#698)',
      'fix(finance): branch codes (#698)',
    ];
    expect(prNumbers(subjects)).toEqual([698, 663]);
  });
});

describe('releaseNotes', () => {
  const bodies: Record<number, string | null> = {
    663: 'Release note (vi): Hướng dẫn cho công ty dịch vụ kế toán.',
    698: 'Release note (vi):',
    700: null,
  };

  it('lists the notes with their PR, and skips PRs without one', () => {
    const md = releaseNotes({
      tag: 'v0.2.0',
      subjects: ['chore: settings (#700)', 'fix: codes (#698)', 'feat: guide (#661) (#663)'],
      body: (pr) => bodies[pr] ?? null,
    });
    expect(md).toBe('## Có gì mới trong v0.2.0\n\n- Hướng dẫn cho công ty dịch vụ kế toán. (#663)\n');
  });

  it('says so when nothing in the release is for the partner', () => {
    const md = releaseNotes({ tag: 'v0.2.1', subjects: ['chore: settings (#700)'], body: () => null });
    expect(md).toBe('## Có gì mới trong v0.2.1\n\nBản này không có thay đổi nào bạn cần biết.\n');
  });
});

describe('readSubjects', () => {
  let dir = '';
  let step = 0;

  const git = (args: string[], isoDate?: string) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: isoDate ? { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate } : process.env,
    });

  const nextDate = () => {
    step += 1;
    const hours = String(Math.floor(step / 60)).padStart(2, '0');
    const minutes = String(step % 60).padStart(2, '0');
    return `2026-11-01T${hours}:${minutes}:00Z`;
  };

  const commit = (message: string) => {
    git(['commit', '--allow-empty', '-q', '-m', message], nextDate());
  };

  const merge = (branch: string, message: string) => {
    git(['merge', '--no-ff', '-q', '-m', message, branch], nextDate());
  };

  function initRepo() {
    step = 0;
    dir = mkdtempSync(join(tmpdir(), 'crove-release-notes-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    git(['config', 'core.hooksPath', join(dir, '.no-hooks')]);
    git(['config', 'core.autocrlf', 'false']);
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('captures dev squash PRs and main direct commits across a promotion merge commit while skipping the merge commit', () => {
    initRepo();
    commit('feat(core): initial setup (#100)');
    git(['tag', 'v0.1.0']);

    git(['checkout', '-q', '-b', 'dev']);
    commit('feat(finance): add export (#101)');
    commit('fix(kernel): retry logic (#102)');

    git(['checkout', '-q', 'main']);
    commit('fix(auth): hotfix session (#103)');
    merge('dev', 'chore(release): promote dev to main (#104)');
    git(['tag', 'v0.2.0']);

    const subjects = readSubjects('v0.1.0', 'v0.2.0', { cwd: dir });
    expect(subjects).toEqual([
      'fix(auth): hotfix session (#103)',
      'fix(kernel): retry logic (#102)',
      'feat(finance): add export (#101)',
    ]);
    expect(prNumbers(subjects)).toEqual([101, 102, 103]);

    const bodies: Record<number, string | null> = {
      100: 'Release note (vi): Thay đổi cũ không được lặp lại.',
      101: 'Release note (vi): Thêm xuất dữ liệu tài chính.',
      102: 'Release note (vi): Sửa lỗi thử lại trong kernel.',
      103: 'Release note (vi): Sửa lỗi phiên đăng nhập.',
      104: 'Release note (vi): Merge commit không được xuất hiện.',
    };
    expect(releaseNotes({ tag: 'v0.2.0', subjects, body: (pr) => bodies[pr] ?? null })).toBe(
      '## Có gì mới trong v0.2.0\n\n- Thêm xuất dữ liệu tài chính. (#101)\n- Sửa lỗi thử lại trong kernel. (#102)\n- Sửa lỗi phiên đăng nhập. (#103)\n',
    );
  }, 60_000);

  it('reads non-merge commits for an initial release across linear and merge-commit history', () => {
    initRepo();
    commit('feat(core): bootstrap (#100)');
    git(['checkout', '-q', '-b', 'feat-branch']);
    commit('feat(web): landing page (#101)');
    git(['checkout', '-q', 'main']);
    commit('fix(ci): lint check (#102)');
    merge('feat-branch', 'Merge pull request #103');
    commit('docs: add readme (#104)');
    git(['tag', 'v0.1.0']);

    const subjects = readSubjects('', 'v0.1.0', { cwd: dir });
    expect(subjects).toEqual([
      'docs: add readme (#104)',
      'fix(ci): lint check (#102)',
      'feat(web): landing page (#101)',
      'feat(core): bootstrap (#100)',
    ]);
    expect(prNumbers(subjects)).toEqual([100, 101, 102, 104]);
  }, 60_000);

  it('does not emit pre-v0.1.0 PRs across an earlier main -> dev sync merge inside v0.1.0..dev', () => {
    initRepo();
    commit('feat(core): pre-release base (#99)');
    git(['checkout', '-q', '-b', 'dev']);
    commit('feat(finance): post-branch dev work (#101)');

    git(['checkout', '-q', 'main']);
    commit('fix(kernel): v0.1.0 release fix (#100)');
    git(['tag', 'v0.1.0']);

    git(['checkout', '-q', 'dev']);
    merge('main', 'Merge branch main into dev (#102)');
    commit('feat(sales): post-sync dev work (#103)');

    const subjects = readSubjects('v0.1.0', 'dev', { cwd: dir });
    expect(subjects).toEqual([
      'feat(sales): post-sync dev work (#103)',
      'feat(finance): post-branch dev work (#101)',
    ]);
    expect(prNumbers(subjects)).toEqual([101, 103]);
  }, 60_000);

  it('throws the usage error for invalid or flag-like refs', () => {
    initRepo();
    commit('feat(core): init (#100)');
    git(['tag', 'v0.1.0']);

    expect(() => readSubjects('', '--exec=touch /tmp/pwn', { cwd: dir })).toThrow(
      'usage: node tools/release-notes.mjs <previous tag or empty> <tag>',
    );
    expect(() => readSubjects('--exec=touch /tmp/pwn', 'v0.1.0', { cwd: dir })).toThrow(
      'usage: node tools/release-notes.mjs <previous tag or empty> <tag>',
    );
    expect(() => readSubjects('', 'v0.1.0..HEAD', { cwd: dir })).toThrow(
      'usage: node tools/release-notes.mjs <previous tag or empty> <tag>',
    );
    expect(() => readSubjects('v0.1.0..HEAD', 'v0.1.0', { cwd: dir })).toThrow(
      'usage: node tools/release-notes.mjs <previous tag or empty> <tag>',
    );
    expect(() => readSubjects('', '', { cwd: dir })).toThrow(
      'usage: node tools/release-notes.mjs <previous tag or empty> <tag>',
    );
  }, 60_000);
});
