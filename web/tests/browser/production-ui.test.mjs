import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { ownerA } from '../integration/music-server-fixture.mjs';
import { productionClient, startBrowserFixture } from './browser-fixture.mjs';

const reviewDir = process.env.BROWSER_REVIEW_DIR || fileURLToPath(new URL('../../test-results/browser/', import.meta.url));
const password = 'Ab12';

async function assertDefaultPasswordAbsent(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertDefaultPasswordAbsent(path);
    else if (/\.(?:html|js|css|svg)$/.test(entry.name)) {
      assert.doesNotMatch(await readFile(path, 'utf8'), /piyan/i,
        'Published website assets must not contain the default password.');
    }
  }
}

async function eventually(check, message, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await delay(50); }
  assert.ok(await check(), message);
}

test('production Vue UI in real Chromium with real authentication, Server SQLite, Nginx and media decoding',
  { timeout: 180000 }, async t => {
  await mkdir(reviewDir, { recursive: true });
  await assertDefaultPasswordAbsent(productionClient);
  const fixture = await startBrowserFixture();
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const report = { browser: browser.version(), environment: 'Linux Chromium; production Vite assets; real Server/Nginx; fake Discord port',
    formats: [], pageErrors: [], consoleErrors: [], assetFailures: [], screenshots: [], limitations: [
      'Firefox and Safari/iOS were not run.', 'No real Discord Gateway or voice/audio channel was connected.',
      'Synthetic sine samples are decode checks, not every codec/profile/container combination.' ] };
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ text: message.text(), location: message.location() }); });
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && (/\/assets\/|favicon/.test(path) || ['script', 'stylesheet', 'image', 'font'].includes(response.request().resourceType())))
      report.assetFailures.push({ url: response.url(), status: response.status() });
  });
  // Observe native Audio without replacing decoding, playback, timing or network behavior.
  await page.addInitScript(() => {
    window.__cirnoAudioElements = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (!window.__cirnoAudioElements.includes(this)) window.__cirnoAudioElements.push(this);
      return play.apply(this, args);
    };
  });
  const player = page.getByRole('contentinfo', { name: '音樂播放器' });
  const search = async title => {
    await page.getByRole('complementary', { name: '主要導覽' }).getByRole('button', { name: '搜尋', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜尋歌曲名稱或演出者' }).fill(title);
    await eventually(async () => await page.getByRole('button', { name: `播放 ${title}`, exact: true }).count() === 1, `Search resolves ${title}`);
  };
  const media = () => page.evaluate(() => {
    const element = window.__cirnoAudioElements.at(-1);
    return element ? { duration: element.duration, currentTime: element.currentTime, readyState: element.readyState,
      paused: element.paused, error: element.error?.code ?? null, src: element.getAttribute('src'), currentSrc: element.currentSrc } : null;
  });
  let playlistId;
  try {
    await t.test('ID-only browser registration and initial login directly open catalog without password hints', async () => {
      await page.goto(`${fixture.website.base}/web/`);
      assert.doesNotMatch(await page.content(), /piyan/i, 'Login markup has no default-password hint.');
      await page.getByRole('button', { name: '建立帳號', exact: true }).click();
      await page.getByRole('heading', { name: '建立帳號', exact: true }).waitFor();
      assert.equal(await page.locator('input[type=password]').count(), 0, 'Registration only asks for a Discord ID.');
      assert.equal(await page.locator('form input').count(), 1);
      assert.doesNotMatch(await page.content(), /piyan/i, 'Registration markup has no default-password hint.');
      await page.getByLabel('Discord 使用者 ID', { exact: true }).fill(ownerA);
      const registration = page.waitForResponse(response => response.url().endsWith('/web/api/auth/register') && response.request().method() === 'POST');
      await page.getByRole('button', { name: '註冊', exact: true }).click();
      const registered = await registration;
      assert.deepEqual(registered.request().postDataJSON(), { discordId: ownerA });
      assert.equal(registered.status(), 201); assert.deepEqual(await registered.json(), { success: true });
      await page.getByRole('heading', { name: '登入音樂室' }).waitFor();
      await page.getByText('帳號已建立，請登入。', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Discord 使用者 ID', { exact: true }).inputValue(), ownerA);
      assert.equal(await page.getByRole('heading', { name: /^全部歌曲/ }).count(), 0, 'Registration does not silently sign in.');
      await page.getByLabel('密碼', { exact: true }).fill('piyan');
      await page.getByRole('button', { name: '登入', exact: true }).click();
      await page.getByRole('heading', { name: /^全部歌曲/ }).waitFor();
      assert.equal(await page.getByRole('heading', { name: '設定你的新密碼' }).count(), 0, 'Initial login does not require a password change.');
      assert.doesNotMatch(await page.content(), /piyan/i, 'Music UI does not reveal the default password.');
      await eventually(async () => await page.locator('.song-row').count() === 26, 'Initial catalog loads 25 rows plus header');
      await page.getByRole('button', { name: '載入更多歌曲' }).click();
      await eventually(async () => await page.locator('.song-row').count() === 34, 'Cursor pagination loads all 33 songs');
      assert.equal(await page.getByRole('link', { name: '上傳歌曲' }).getAttribute('href'), '/web/upload');
      assert.equal(await page.locator('.song-row').getByRole('button', { name: /刪除|修改/ }).count(), 0);
      assert.match(await page.locator('.voice-notice').innerText(), /請先加入.*Discord.*語音頻道/);
      const upload = await fixture.website.request('/web/upload', { session: (await fixture.website.login(ownerA, 'piyan')).session });
      assert.equal(upload.status, 302); assert.equal(upload.headers.get('location'), new URL('admin', fixture.server.base).href);
      await page.screenshot({ path: join(reviewDir, 'desktop-library.png'), fullPage: true }); report.screenshots.push('desktop-library.png');
    });

    await t.test('voluntary settings change accepts four English letters/digits and invalidates the old login', async () => {
      await page.getByRole('button', { name: '開啟帳號設定', exact: true }).click();
      await page.getByRole('heading', { name: '帳號設定', exact: true }).waitFor();
      assert.doesNotMatch(await page.content(), /piyan/i, 'Settings have no default-password hint.');
      await page.getByLabel('目前密碼', { exact: true }).fill('piyan');
      await page.getByLabel('新密碼', { exact: true }).fill(password);
      await page.getByLabel('再次輸入新密碼', { exact: true }).fill(password);
      await page.getByRole('button', { name: '更新密碼', exact: true }).click();
      await page.getByRole('heading', { name: '登入音樂室' }).waitFor();
      await page.getByLabel('Discord 使用者 ID', { exact: true }).fill(ownerA);
      await page.getByLabel('密碼', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登入', exact: true }).click();
      await page.getByRole('heading', { name: /^全部歌曲/ }).waitFor();
      assert.equal((await fixture.website.login(ownerA, 'piyan')).response.status, 401);
    });

    await t.test('own playlists create, add duplicates, order, remove, rename and stale destructive confirmation', async () => {
      const nav = page.getByRole('complementary', { name: '主要導覽' });
      await nav.getByRole('button', { name: '我的清單', exact: true }).click();
      await page.getByRole('button', { name: '建立清單', exact: true }).click();
      await page.getByRole('dialog').getByLabel('清單名稱').fill('Browser 私人收藏');
      await page.getByRole('dialog').getByRole('button', { name: '儲存', exact: true }).click();
      await page.locator('.playlist-detail h2').filter({ hasText: 'Browser 私人收藏' }).waitFor();
      playlistId = (await fixture.server.db.playlist.findFirst({ where: { ownerId: ownerA, name: 'Browser 私人收藏' } })).id;
      for (const sample of [fixture.samples[0], fixture.samples[1], fixture.samples[0]]) {
        await search(sample.song.title);
        const response = page.waitForResponse(response => response.url().endsWith(`/playlists/${playlistId}/entries`) && response.request().method() === 'POST');
        await page.getByLabel(`${sample.song.title} 加入清單`, { exact: true }).selectOption(playlistId);
        assert.equal((await response).status(), 200);
        await nav.getByRole('button', { name: '我的清單', exact: true }).click();
        await page.locator('.playlist-detail').waitFor();
      }
      await eventually(async () => await page.locator('.playlist-entries li').count() === 3, 'Duplicate entries are retained');
      const titles = () => page.locator('.playlist-entries li strong').allTextContents();
      assert.deepEqual(await titles(), ['Browser sample MP3', 'Browser sample M4A AAC', 'Browser sample MP3']);
      await page.getByRole('button', { name: 'Browser sample M4A AAC 上移', exact: true }).click();
      await eventually(async () => (await titles())[0] === 'Browser sample M4A AAC', 'Playlist reorder changes stored positions');
      await page.getByRole('button', { name: '移除收藏 Browser sample MP3', exact: true }).last().click();
      await eventually(async () => await page.locator('.playlist-entries li').count() === 2, 'Remove operates on a single entry ID');
      await page.getByRole('button', { name: '重新命名清單', exact: true }).click();
      await page.getByRole('dialog').getByLabel('清單名稱').fill('Browser 重命名');
      await page.getByRole('dialog').getByRole('button', { name: '儲存', exact: true }).click();
      await page.locator('.playlist-detail h2').filter({ hasText: 'Browser 重命名' }).waitFor();
      await page.getByRole('button', { name: '刪除清單', exact: true }).click();
      const current = await fixture.server.request(`/v1/playlists/${playlistId}`); const list = await current.json();
      const concurrent = await fixture.server.request(`/v1/playlists/${playlistId}`, { method: 'PATCH', body: { revision: list.revision, name: 'Bot 同時修改後保留' } });
      assert.equal(concurrent.status, 200);
      await page.getByRole('dialog').getByRole('button', { name: '確認刪除', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '清單已被其他操作更新' }).waitFor();
      assert.equal((await fixture.server.request(`/v1/playlists/${playlistId}`)).status, 200, 'Stale delete did not remove the concurrent edit');
      await page.locator('.playlist-detail h2').filter({ hasText: 'Bot 同時修改後保留' }).waitFor();
      await page.screenshot({ path: join(reviewDir, 'desktop-playlist-conflict.png'), fullPage: true }); report.screenshots.push('desktop-playlist-conflict.png');
      await page.getByRole('button', { name: '刪除清單', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '確認刪除', exact: true }).click();
      await eventually(async () => (await fixture.server.request(`/v1/playlists/${playlistId}`)).status === 404, 'Fresh destructive confirmation deletes only the playlist');
      assert.equal(await fixture.server.db.song.count(), 33);
    });

    await t.test('native browser decoding, pause/resume, seek, queue and target cleanup', async () => {
      await page.getByRole('group', { name: '播放目標' }).getByRole('button', { name: '此瀏覽器', exact: true }).click();
      for (const sample of fixture.samples) {
        await search(sample.song.title);
        await page.getByRole('button', { name: `播放 ${sample.song.title}`, exact: true }).click();
        await eventually(async () => { const state = await media(); return state?.currentSrc.includes(sample.song.id) && (state.currentTime > 0 || state.error); }, `Native decode settles for ${sample.key}`, 15000);
        const state = await media();
        const capability = await page.evaluate(mime => document.createElement('audio').canPlayType(mime), sample.mime);
        report.formats.push({ format: sample.key, mime: sample.mime, canPlayType: capability, ...state, decoded: state.readyState >= 2 && state.currentTime > 0 && !state.error });
        assert.equal(state.error, null, `${sample.key}: native decode error`);
        assert.ok(state.readyState >= 2 && state.currentTime > 0, `${sample.key} decoded real bytes and advanced playback`);
        assert.ok(state.duration >= 11 && state.duration <= 13, `${sample.key}: decoded duration`);
      }
      await player.getByRole('button', { name: '暫停', exact: true }).click();
      await eventually(async () => (await media()).paused, 'Pause reaches native media');
      const progress = player.getByRole('slider', { name: '播放進度' });
      await progress.evaluate(element => { element.value = '5'; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); });
      await eventually(async () => Math.abs((await media()).currentTime - 5) < .5, 'Seek reaches decoded native media');
      await player.getByRole('button', { name: '繼續播放', exact: true }).click();
      await eventually(async () => !(await media()).paused, 'Resume reaches native media');
      await search(fixture.samples[0].song.title);
      await page.getByRole('button', { name: `${fixture.samples[0].song.title} 加入佇列`, exact: true }).click();
      const queue = page.getByRole('complementary', { name: '待播佇列', exact: true });
      if (await queue.getAttribute('inert') !== null) await player.getByRole('button', { name: '切換待播佇列' }).click();
      await queue.locator('.queue-item strong').filter({ hasText: fixture.samples[0].song.title }).waitFor();
      await queue.getByRole('button', { name: `${fixture.samples[0].song.title} 從待播移除`, exact: true }).click();
      assert.equal(await queue.locator('.queue-item').count(), 0);
      await page.getByRole('group', { name: '播放目標' }).getByRole('button', { name: /Discord 語音/ }).click();
      await eventually(async () => (await media()).paused, 'Switching to Discord pauses native browser audio');
      assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), 'none', 'Browser Media Session controls are cleared on target change');
      assert.equal(fixture.bot.commands.length, 0, 'Browser controls do not issue Discord commands');
    });

    await t.test('undecodable audio exposes a real error; Discord commands, external SSE and STOP while loading', async () => {
      await page.getByRole('group', { name: '播放目標' }).getByRole('button', { name: '此瀏覽器', exact: true }).click();
      await search(fixture.brokenSong.title);
      await page.getByRole('button', { name: `播放 ${fixture.brokenSong.title}`, exact: true }).click();
      await page.getByRole('alert').waitFor();
      assert.ok((await media()).error || (await media()).paused, 'Corrupt bytes never count as successful playback');
      await page.getByRole('group', { name: '播放目標' }).getByRole('button', { name: /Discord 語音/ }).click();
      fixture.bot.setInVoice(true);
      await page.getByRole('button', { name: '重新整理語音狀態' }).click();
      await page.getByText('Cirno 測試伺服器 · 音樂測試室', { exact: true }).waitFor();
      await search(fixture.samples[0].song.title);
      await page.getByRole('button', { name: `播放 ${fixture.samples[0].song.title}`, exact: true }).click();
      await player.getByRole('button', { name: '暫停', exact: true }).waitFor();
      assert.equal(fixture.bot.commands.at(-1).command.action, 'enqueue');
      assert.equal(fixture.bot.commands.at(-1).userId, ownerA);
      await player.getByRole('button', { name: '暫停', exact: true }).click();
      await eventually(() => fixture.bot.state.status === 'paused', 'Discord pause crosses real command HTTP boundary');
      fixture.bot.external({ status: 'playing' });
      await player.getByRole('button', { name: '暫停', exact: true }).waitFor();
      await player.getByRole('button', { name: '停止播放', exact: true }).click();
      await eventually(() => fixture.bot.state.status === 'idle', 'Discord stop command ends fixture session');
      fixture.bot.holdNextEnqueue();
      await page.getByRole('button', { name: `播放 ${fixture.samples[0].song.title}`, exact: true }).click();
      const stop = player.getByRole('button', { name: '停止載入', exact: true });
      await stop.waitFor();
      assert.equal(await stop.isEnabled(), true, 'Urgent STOP stays available while enqueue HTTP is pending');
      await stop.click();
      await eventually(() => fixture.bot.state.status === 'idle' && fixture.bot.commands.at(-1).command.action === 'stop', 'Urgent STOP reaches independent HTTP lane');
      await eventually(async () => (await player.locator('.now-playing strong').innerText()) === '準備聽點音樂？', 'The old enqueue response cannot resurrect the stopped snapshot');
    });

    await t.test('desktop/mobile fit, logout releases media/subscriptions and production assets have no errors', async () => {
      await page.getByRole('group', { name: '播放目標' }).getByRole('button', { name: '此瀏覽器', exact: true }).click();
      await search(fixture.samples[0].song.title);
      await page.getByRole('button', { name: `播放 ${fixture.samples[0].song.title}`, exact: true }).click();
      await eventually(async () => (await media()).currentTime > 0, 'Browser playing before cleanup');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Desktop has no horizontal overflow');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('complementary', { name: '待播佇列', exact: true }).getByRole('button', { name: '關閉佇列', exact: true }).click();
      await eventually(() => page.locator('.queue-panel').evaluate(element => element.getBoundingClientRect().left >= innerWidth), 'Mobile queue close animation finishes');
      await eventually(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile has no horizontal overflow');
      await page.screenshot({ path: join(reviewDir, 'mobile-browser-player.png'), fullPage: true }); report.screenshots.push('mobile-browser-player.png');
      await page.getByRole('navigation', { name: '手機導覽' }).getByRole('button', { name: '設定', exact: true }).click();
      await page.getByRole('button', { name: '登出這個音樂室', exact: true }).click();
      await page.getByRole('heading', { name: '登入音樂室' }).waitFor();
      await eventually(async () => { const state = await media(); return state.paused && !state.src; }, 'Logout removes native audio source');
      assert.deepEqual(report.pageErrors, []);
      assert.deepEqual(report.assetFailures, []);
      const unexpected = report.consoleErrors.filter(item => !/Failed to load resource: the server responded with a status of (401|409) /.test(item.text));
      assert.deepEqual(unexpected, [], 'Only expected unauthenticated GET and intentionally stale confirmation HTTP errors are allowed');
    });
  } finally {
    await page.screenshot({ path: join(reviewDir, 'last-browser-state.png'), fullPage: true }).catch(() => {});
    await writeFile(join(reviewDir, 'chromium-review.json'), JSON.stringify(report, null, 2));
    await context.close(); await browser.close(); await fixture.close();
  }
});
