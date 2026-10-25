// A PR's before/after GIFs for an app whose CI records its scenarios as
// videos (the `gif.source` setting "ci-videos": sift, on the iOS Simulator,
// each touch drawn as a ring). cli.mjs hands over to this. Needs gh (signed
// in), git, unzip and ffmpeg.
//
//   node ../ci/gif/cli.mjs <pr> [--side-by-side] [--no-before] [--width <px>] [--fps <n>] [--repo owner/name]
//
// What it reads from the `gif.videos` setting (settings.mjs): the workflow
// that records (`workflow`), the artifact it uploads, one <scenario>.mp4 per
// scenario with any that stopped early set aside in failed/ (`artifact`),
// the inputs that make a run by hand on main record only the scenarios
// (`inputs`) and the one naming the commit whose scenarios it records
// (`scenariosInput`), the drawn ring's colour (`ringColor`), and each GIF's
// width and frame rate.
//
// 1. "After": waits for the PR head's pull_request run of the workflow and
//    takes its artifact. A scenario that stopped early is left out.
// 2. "Before": runs the workflow by hand on main with those inputs and the
//    PR's head as the scenarios' commit, so the same steps play against
//    main's app, and takes that run's artifact (unless --no-before, for a
//    screen main doesn't have).
// 3. Turns each video into a GIF (video.mjs): the waits between touches cut,
//    idle ends trimmed, still frames dropped at real timing, scaled sharp.
//    --side-by-side also joins each pair into one labelled GIF playing in
//    step.
// 4. Commits them to the pictures branch under <pr>/ as
//    <scenario>-before.gif and so on (publish.mjs), and prints the table for
//    the PR description, linked by that commit's SHA.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  gitIn,
  gifNames,
  markdownTable,
  publishFiles,
  rawUrl,
  repoFromRemote,
  sizeNote,
} from './publish.mjs';
import {
  activeWindow,
  cutFilter,
  finalDelayCs,
  gifFilter,
  keptStretches,
  keptTimes,
  lastChangeIn,
  parseColor,
  ringPixels,
  touchSpans,
  videoSideBySideFilter,
} from './video.mjs';

/** @typedef {import('./settings.mjs').GifSettings} GifSettings */
/** @typedef {import('./video.mjs').Window} Window */
/** @typedef {import('./video.mjs').GifOptions} GifOptions */

/** How often and how long it waits on a run; tests shorten them. */
export const timing = {
  pollMs: 30_000,
  waitLimitMs: 3 * 60 * 60 * 1000,
  startLimitMs: 5 * 60 * 1000,
};

/** A bold font for the side-by-side labels, where one is found. */
const FONT =
  [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  ].find((file) => existsSync(file)) ?? null;

/** @param {string} line */
const log = (line) => process.stderr.write(`${line}\n`);

/**
 * @typedef {object} VideoOptions What videos.mjs was asked to do.
 * @property {number} pr
 * @property {string | undefined} repo
 * @property {boolean} sideBySide
 * @property {number} width
 * @property {number} fps
 * @property {boolean} noBefore skip the "before" run: a new screen has nothing on main to compare
 */

/**
 * Reads the command line, with the width and frame rate from the settings
 * unless given.
 *
 * @param {readonly string[]} argv
 * @param {{ width: number; fps: number }} defaults
 * @returns {VideoOptions}
 */
export function parseVideoArgs(argv, defaults) {
  /** @type {VideoOptions} */
  const options = {
    pr: NaN,
    repo: undefined,
    sideBySide: false,
    width: defaults.width,
    fps: defaults.fps,
    noBefore: false,
  };
  /**
   * @param {string} flag
   * @param {string | undefined} value
   */
  const number = (flag, value) => {
    const n = Number(value);
    if (!value || !Number.isInteger(n) || n <= 0)
      throw new Error(`${flag} needs a whole number above 0`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--side-by-side') options.sideBySide = true;
    else if (arg === '--no-before') options.noBefore = true;
    else if (arg === '--width') options.width = number(arg, argv[++i]);
    else if (arg === '--fps') options.fps = number(arg, argv[++i]);
    else if (arg === '--repo') {
      const repo = argv[++i];
      if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo needs owner/name');
      options.repo = repo;
    } else if (/^\d+$/.test(arg) && Number.isNaN(options.pr)) options.pr = Number(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (Number.isNaN(options.pr)) throw new Error('Give the PR number');
  if (options.sideBySide && options.noBefore) throw new Error('--side-by-side needs a before');
  return options;
}

/**
 * Runs a command in the app's checkout; a failure throws unless `allowFail`.
 *
 * @param {string} cmd
 * @param {readonly string[]} args
 * @param {{ allowFail?: boolean; cwd?: string }} [options]
 */
export function run(cmd, args, { allowFail = false, cwd } = {}) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (out.status !== 0 && !allowFail) {
    throw new Error(
      `${cmd} ${args.slice(0, 4).join(' ')} failed: ${(out.stderr || out.stdout).slice(0, 500)}`,
    );
  }
  return out;
}

/**
 * gh api's answer, parsed, as the shape the caller reads.
 *
 * @template T
 * @param {readonly string[]} args
 * @returns {T}
 */
const ghJson = (args) => /** @type {T} */ (JSON.parse(run('gh', ['api', ...args]).stdout));

/**
 * @typedef {object} Run A workflow run, as much of it as this reads.
 * @property {number} id
 * @property {string} [status]
 * @property {string | null} [conclusion]
 */

/**
 * Waits for a run to finish. A cancelled one is an error; a red one (a
 * failing test, say) still recorded its videos, which are used.
 *
 * @param {string} repo
 * @param {number} runId
 * @returns {Promise<Run>}
 */
export async function waitForRun(repo, runId) {
  const startedAt = Date.now();
  for (;;) {
    /** @type {Run} */
    const r = ghJson([`repos/${repo}/actions/runs/${runId}`]);
    if (r.status === 'completed') {
      if (r.conclusion === 'cancelled') {
        throw new Error(`Run ${runId} was cancelled before it finished: run this again`);
      }
      if (r.conclusion !== 'success')
        log(`  run ${runId} ended ${r.conclusion}; using its videos anyway`);
      return r;
    }
    if (Date.now() - startedAt > timing.waitLimitMs) {
      throw new Error(`Run ${runId} still ${r.status} after ${timing.waitLimitMs / 3_600_000} h`);
    }
    log(`  run ${runId}: ${r.status}…`);
    await sleep(timing.pollMs);
  }
}

/**
 * Downloads a run's videos into `into`: { scenario: file }. A scenario that
 * stopped before its last step (set aside in failed/) is warned of and left
 * out.
 *
 * @param {string} repo
 * @param {number} runId
 * @param {string} artifactName
 * @param {string} into
 * @returns {Record<string, string>}
 */
export function downloadVideos(repo, runId, artifactName, into) {
  /** @type {{ artifacts: { id: number; name: string }[] }} */
  const { artifacts } = ghJson([`repos/${repo}/actions/runs/${runId}/artifacts`]);
  const artifact = artifacts.find((a) => a.name === artifactName);
  if (!artifact) throw new Error(`Run ${runId} has no ${artifactName} artifact`);
  const zip = path.join(into, 'videos.zip');
  // Binary: straight to a file, not through a string.
  const r = spawnSync('gh', ['api', `repos/${repo}/actions/artifacts/${artifact.id}/zip`], {
    maxBuffer: 1024 ** 3,
  });
  if (r.status !== 0) throw new Error(`Downloading the videos of run ${runId} failed`);
  writeFileSync(zip, r.stdout);
  run('unzip', ['-q', '-o', zip, '-d', into]);
  const failed = path.join(into, 'failed');
  for (const f of existsSync(failed) ? readdirSync(failed) : []) {
    log(
      `  warning: run ${runId}'s ${path.basename(f, '.mp4')} stopped before its last step; no GIF of it`,
    );
  }
  return Object.fromEntries(
    readdirSync(into)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => [path.basename(f, '.mp4'), path.join(into, f)]),
  );
}

/**
 * The PR head's run: the newest pull_request run of the workflow on that
 * commit, once one has started.
 *
 * @param {string} repo
 * @param {string} workflow
 * @param {string} sha
 * @returns {Promise<Run>}
 */
export async function afterRun(repo, workflow, sha) {
  for (const startedAt = Date.now(); ;) {
    /** @type {{ workflow_runs: Run[] }} */
    const { workflow_runs: runs } = ghJson([
      `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=pull_request&per_page=5`,
    ]);
    if (runs.length > 0) return runs[0];
    if (Date.now() - startedAt > timing.waitLimitMs)
      throw new Error(`No ${workflow} run for ${sha}`);
    log(`  waiting for ${workflow} to start on ${sha.slice(0, 7)}…`);
    await sleep(timing.pollMs);
  }
}

/**
 * @param {string} repo
 * @param {string} workflow
 * @returns {Run[]}
 */
const dispatchRuns = (repo, workflow) =>
  /** @type {{ workflow_runs: Run[] }} */ (
    ghJson([
      `repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=main&per_page=5`,
    ])
  ).workflow_runs;

/**
 * Runs the workflow by hand on main, recording the PR's scenarios only.
 *
 * @param {string} repo
 * @param {import('./settings.mjs').VideoSettings} videos
 * @param {string} sha
 * @returns {Promise<Run>}
 */
export async function beforeRun(repo, videos, sha) {
  // Runs by hand before this one, so a run found later is ours (not
  // another dispatch's, and with no trust in the local clock).
  const newestBefore = Math.max(0, ...dispatchRuns(repo, videos.workflow).map((r) => r.id));
  // Inputs go as strings (-f): the dispatch API turns away a JSON boolean.
  const dispatch = [
    '-X',
    'POST',
    `repos/${repo}/actions/workflows/${videos.workflow}/dispatches`,
    '-f',
    'ref=main',
  ];
  for (const [name, value] of Object.entries(videos.inputs))
    dispatch.push('-f', `inputs[${name}]=${value}`);
  dispatch.push('-f', `inputs[${videos.scenariosInput}]=${sha}`);
  // GitHub names the run it started when asked; if it turns the question
  // away (422: nothing was dispatched), ask without it.
  let reply = run('gh', ['api', ...dispatch, '-F', 'return_run_details=true'], { allowFail: true });
  if (reply.status !== 0 && /422|return_run_details/.test(reply.stderr))
    reply = run('gh', ['api', ...dispatch]);
  else if (reply.status !== 0)
    throw new Error(`Starting the run on main failed: ${reply.stderr.slice(0, 500)}`);
  /** @type {{ workflow_run_id?: unknown }} */
  const answer = reply.stdout.trim() ? JSON.parse(reply.stdout) : {};
  const named = answer.workflow_run_id;
  if (typeof named === 'number') return { id: named };
  for (const startedAt = Date.now(); ;) {
    const found = dispatchRuns(repo, videos.workflow)
      .filter((r) => r.id > newestBefore)
      .sort((a, b) => a.id - b.id)[0];
    if (found) return found;
    if (Date.now() - startedAt > timing.startLimitMs)
      throw new Error('The run on main never started');
    await sleep(Math.min(5000, timing.pollMs));
  }
}

/**
 * A video's width and height.
 *
 * @param {string} video
 * @returns {[number, number]}
 */
function size(video) {
  const [w, h] = run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    video,
  ])
    .stdout.trim()
    .split(',')
    .map(Number);
  return [w, h];
}

/** @param {string} video */
const duration = (video) =>
  Number(
    run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video])
      .stdout,
  );

/**
 * Each frame's ring-pixel count, streamed from ffmpeg at a third of the size.
 *
 * @param {string} video
 * @param {readonly [number, number, number]} ring
 */
export async function ringCounts(video, ring) {
  const [w, h] = size(video);
  const width = 2 * Math.round(w / 6);
  const height = 2 * Math.round(h / 6);
  const frameBytes = width * height * 3;
  const times = run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=pts_time',
    '-of',
    'csv=p=0',
    video,
  ])
    .stdout.split(/\s+/)
    .filter(Boolean)
    .map((t) => Number(t.replace(/,$/, '')));
  /** @type {number[]} */
  const counts = [];
  const decoder = spawn('ffmpeg', [
    '-v',
    'error',
    '-i',
    video,
    '-vf',
    `scale=${width}:${height}`,
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ]);
  const closed = new Promise((done) => decoder.on('close', done));
  let pending = Buffer.alloc(0);
  for await (const chunk of decoder.stdout) {
    pending = Buffer.concat([pending, /** @type {Buffer} */ (chunk)]);
    while (pending.length >= frameBytes) {
      counts.push(ringPixels(pending.subarray(0, frameBytes), ring));
      pending = pending.subarray(frameBytes);
    }
  }
  const code = await closed;
  if (code !== 0) throw new Error(`decoding ${path.basename(video)} failed`);
  return { times: times.slice(0, counts.length), counts };
}

/**
 * The video with the waits between its touches cut (video.mjs), or the
 * video itself when no touch shows in it.
 *
 * @param {string} video
 * @param {readonly [number, number, number]} ring
 */
export async function cutWaits(video, ring) {
  const length = duration(video);
  const { times, counts } = await ringCounts(video, ring);
  const stretches = keptStretches(touchSpans(times, counts), length);
  if (!stretches) {
    log(
      `  ${path.basename(video)}: no drawn touch found (were touches drawn?); keeping its whole length`,
    );
    return video;
  }
  const out = video.replace(/\.mp4$/, '.cut.mp4');
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    video,
    '-filter_complex',
    cutFilter(stretches),
    '-map',
    '[cut]',
    '-fps_mode',
    'vfr',
    '-c:v',
    'libx264',
    '-crf',
    '12',
    '-preset',
    'veryfast',
    out,
  ]);
  const kept = stretches.reduce((sum, w) => sum + w.end - w.start, 0);
  log(
    `  ${path.basename(video)}: ${stretches.length} touch stretch(es) kept, ${kept.toFixed(1)} s of ${length.toFixed(1)} s`,
  );
  return out;
}

/**
 * Where a video changes, and the window worth keeping.
 *
 * @param {string} video
 * @returns {{ times: number[]; window: Window | null }}
 */
function analyse(video) {
  const probe = run(
    'ffmpeg',
    ['-hide_banner', '-i', video, '-vf', 'mpdecimate,showinfo', '-f', 'null', '-'],
    {
      allowFail: true,
    },
  );
  const times = keptTimes(probe.stderr);
  return { times, window: activeWindow(times, duration(video)) };
}

/**
 * @typedef {object} Analysis
 * @property {number[]} times
 * @property {Window} window
 */

/**
 * One video to one GIF at `out`.
 *
 * @param {string} video
 * @param {string} out
 * @param {GifOptions} options
 * @returns {Analysis}
 */
export function makeGif(video, out, options) {
  const { times, window } = analyse(video);
  if (!window) throw new Error('nothing ever changed on screen');
  const finalDelay = finalDelayCs(lastChangeIn(times, window), window.end - window.start);
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(window.start),
    '-to',
    String(window.end),
    '-i',
    video,
    '-vf',
    gifFilter(options),
    '-fps_mode',
    'vfr',
    '-final_delay',
    String(finalDelay),
    '-loop',
    '0',
    out,
  ]);
  return { times, window };
}

/**
 * A pair of videos side by side in one GIF at `out`.
 *
 * @param {{ video: string; analysis: Analysis }} before
 * @param {{ video: string; analysis: Analysis }} after
 * @param {string} out
 * @param {GifOptions} options
 */
export function makeSideBySide(before, after, out, options) {
  /** @param {Analysis} a */
  const length = (a) => a.window.end - a.window.start;
  const longest = Math.max(length(before.analysis), length(after.analysis));
  const lastChange = Math.max(
    lastChangeIn(before.analysis.times, before.analysis.window),
    lastChangeIn(after.analysis.times, after.analysis.window),
  );
  /** @param {string} video */
  const aspect = (video) => {
    const [w, h] = size(video);
    return h / w;
  };
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    before.video,
    '-i',
    after.video,
    '-filter_complex',
    videoSideBySideFilter(
      { ...options, width: options.width * 2 },
      before.analysis.window,
      after.analysis.window,
      FONT,
      Math.max(aspect(before.video), aspect(after.video)),
    ),
    '-fps_mode',
    'vfr',
    '-final_delay',
    String(finalDelayCs(lastChange, longest)),
    '-loop',
    '0',
    out,
  ]);
}

/**
 * @param {readonly string[]} argv
 * @param {{ root: string; settings: GifSettings }} app
 */
export async function main(argv, { root, settings }) {
  const { videos } = settings;
  const options = parseVideoArgs(argv, videos);
  const ring = parseColor(videos.ringColor);
  const origin = run('git', ['remote', 'get-url', 'origin'], { cwd: root }).stdout;
  const repo = options.repo ?? repoFromRemote(origin);
  // The GIFs are pushed to this clone's origin: links to another repository
  // would show nothing.
  if (options.repo && /github\.com/.test(origin) && repoFromRemote(origin) !== options.repo) {
    throw new Error(
      `This clone's origin (${origin.trim()}) isn't ${options.repo}, where the links will point`,
    );
  }
  if (
    options.sideBySide &&
    !/\sdrawtext\s/.test(run('ffmpeg', ['-hide_banner', '-filters']).stdout)
  ) {
    throw new Error(
      '--side-by-side labels each side with drawtext, which this ffmpeg lacks (build it with freetype)',
    );
  }
  const { pr } = options;
  /** @type {{ head: { sha: string } }} */
  const pull = ghJson([`repos/${repo}/pulls/${pr}`]);
  const head = pull.head.sha;
  const work = mkdtempSync(path.join(tmpdir(), `pr-gifs-${pr}-`));
  try {
    log(`PR #${pr} at ${head.slice(0, 7)}: waiting for its ${videos.workflow} run (after)…`);
    const afterId = (await afterRun(repo, videos.workflow, head)).id;
    const beforeId = options.noBefore ? null : (await beforeRun(repo, videos, head)).id;
    if (beforeId) log(`Recording the same scenarios on main: run ${beforeId} (before)…`);
    const [afterDone, beforeDone] = await Promise.all([
      waitForRun(repo, afterId),
      beforeId ? waitForRun(repo, beforeId) : Promise.resolve(null),
    ]);
    const afterVideos = downloadVideos(
      repo,
      afterDone.id,
      videos.artifact,
      mkdtempSync(path.join(work, 'after-')),
    );
    const beforeVideos = beforeDone
      ? downloadVideos(
          repo,
          beforeDone.id,
          videos.artifact,
          mkdtempSync(path.join(work, 'before-')),
        )
      : {};
    const names = Object.keys(afterVideos).sort();
    if (names.length === 0) throw new Error('The PR run recorded no GIF scenarios');

    // Cut each recording's waits for the test driver, found by its drawn touches.
    for (const recorded of [afterVideos, beforeVideos]) {
      for (const [name, video] of Object.entries(recorded)) {
        try {
          recorded[name] = await cutWaits(video, ring);
        } catch (err) {
          log(
            `  warning: ${name}: cutting its waits failed (${err instanceof Error ? err.message : err}); keeping it whole`,
          );
        }
      }
    }

    /** @type {[string, string][]} */
    const files = [];
    /** @type {import('./publish.mjs').Published[]} */
    const scenarios = [];
    /**
     * One video that can't be made into a GIF is a warning; the rest go on.
     *
     * @template T
     * @param {string} what
     * @param {() => T} make
     * @returns {T | null}
     */
    const attempt = (what, make) => {
      try {
        return make();
      } catch (err) {
        log(`  warning: ${what}: ${err instanceof Error ? err.message : err}`);
        return null;
      }
    };
    const dir = String(pr);
    for (const name of names) {
      const named = gifNames(name);
      /** @param {'before' | 'after'} side */
      const gif = (side) => {
        const video = (side === 'after' ? afterVideos : beforeVideos)[name];
        const out = path.join(work, named[side]);
        const analysis = attempt(`${name} (${side})`, () => makeGif(video, out, options));
        if (!analysis) return null;
        files.push([`${dir}/${named[side]}`, out]);
        return { video, analysis };
      };
      const after = gif('after');
      if (!after) continue;
      let before = null;
      if (beforeVideos[name]) before = gif('before');
      else if (!options.noBefore)
        log(`  ${name}: main has no recording of it (a new scenario?); after only`);
      let sideBySide = null;
      if (options.sideBySide && before) {
        const out = path.join(work, named.side);
        const joined = before;
        if (
          attempt(
            `${name} (side by side)`,
            () => (makeSideBySide(joined, after, out, options), true),
          )
        ) {
          files.push([`${dir}/${named.side}`, out]);
          sideBySide = `${dir}/${named.side}`;
        }
      }
      scenarios.push({
        name,
        before: before ? `${dir}/${named.before}` : null,
        after: `${dir}/${named.after}`,
        sideBySide,
      });
    }
    if (scenarios.length === 0) throw new Error('No GIF could be made');

    for (const [file, local] of files) {
      const note = sizeNote(file, statSync(local).size);
      if (note.includes('over 5 MB')) log(`  warning: ${note}`);
    }
    const sha = publishFiles(gitIn(root), files, {
      message: `Add PR #${pr}'s GIFs\n\nFrom ${videos.workflow} runs ${afterDone.id}${beforeDone ? ` and ${beforeDone.id}` : ''}, made by jbhirsh/ci's gif/videos.mjs.`,
      branch: settings.branch,
      push: true,
      log,
    });
    for (const [file] of files) {
      const status = run(
        'curl',
        ['-s', '-o', '/dev/null', '-w', '%{http_code}', rawUrl(repo, sha, file)],
        {
          allowFail: true,
        },
      ).stdout;
      if (status !== '200') log(`  warning: ${file} answered ${status}`);
    }
    process.stdout.write(`${markdownTable(repo, sha, scenarios, { width: settings.cellWidth })}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
