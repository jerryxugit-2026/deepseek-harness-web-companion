#!/usr/bin/env node
/**
 * 版本号一致性门禁（2026-09-13 加）。
 *
 * 由来：发第一个 Release 之前盘点发现**三个说法** —— package.json 0.1.0、
 * extension/manifest.json 0.1.0、docs/CHANGELOG.md v3.47。release 的 tag 必须能对上代码里的版本，
 * 否则"检查更新"会算错；而这种事一旦靠人记，就一定会再漂。
 *
 * 这条门禁把权威版本钉成**一处**（根 package.json），其余全部必须与它逐字一致：
 *   · dsh-plugin/package.json   · extension/package.json
 *   · extension/manifest.json（Chrome 用它，且必须 1–4 段数字）
 *   · dsh-plugin/src/host/index.js 的 PLUGIN_VERSION（`/ag/ping` 会把它报给引导程序）
 *   · docs/CHANGELOG.md 最新那条 `## vX.Y.Z`
 * 改一处漏一处 ⇒ 这里红。
 */
import { readFileSync } from 'node:fs'
import { createRecorder } from './_record.mjs'

const { results, record, finish } = createRecorder()

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const authoritative = JSON.parse(read('package.json')).version
record(`权威版本来自根 package.json（当前 ${authoritative}）`, typeof authoritative === 'string' && /^\d+\.\d+\.\d+$/u.test(authoritative))

record('dsh-plugin/package.json 与它一致', JSON.parse(read('dsh-plugin/package.json')).version === authoritative)
record('extension/package.json 与它一致', JSON.parse(read('extension/package.json')).version === authoritative)
record('extension/manifest.json 与它一致（Chrome 用的就是它）', JSON.parse(read('extension/manifest.json')).version === authoritative)
record('manifest 的版本是合法 Chrome 版本号（1–4 段数字）',
  /^\d+(\.\d+){0,3}$/u.test(JSON.parse(read('extension/manifest.json')).version))
const pluginSrc = read('dsh-plugin/src/host/index.js')
record('PLUGIN_VERSION 与它一致（/ag/ping 报给引导程序的就是这个）',
  new RegExp(`const PLUGIN_VERSION = '${authoritative.replace(/\./gu, '\\.')}'`, 'u').test(pluginSrc))
const changelog = read('docs/CHANGELOG.md')
const latest = /^## v(\d+\.\d+(?:\.\d+)?)/mu.exec(changelog)?.[1] ?? null
record(`CHANGELOG 最新条目与它一致（CHANGELOG 是 v${String(latest)}）`,
  latest !== null && authoritative.startsWith(latest))

finish()
